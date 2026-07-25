import { z } from "#compiled/zod/index.js";

import { createLogger, logError } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { EVE_CALLBACK_ROUTE_PATTERN } from "#protocol/routes.js";
import { ingestSessionNotification } from "#execution/notification-ingestion.js";
import type {
  SessionCallbackPayload,
  SessionCallbackTerminationEvent,
} from "#channel/session-callback.js";
import type { HookPayload, SubagentAuthorizationEvent } from "#channel/types.js";
import type { SubagentChildEventStreamEvent } from "#protocol/message.js";
import type { ChannelMethod, RouteContext } from "#public/definitions/channel.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import { tokenUsageSchema, type TokenUsage } from "#shared/token-usage.js";

export const HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX = "eve/v1/callback";

const log = createLogger("runtime.session-callback-route");

const HANDLED_METHODS: readonly ChannelMethod[] = ["POST"];

export function getSessionCallbackChannelDefinitions(): readonly ResolvedChannelDefinition[] {
  return HANDLED_METHODS.map((method) => buildCallbackChannelDefinition(method));
}

export function getSessionCallbackChannelNames(): ReadonlySet<string> {
  return new Set(HANDLED_METHODS.map(channelNameForMethod));
}

function buildCallbackChannelDefinition(method: ChannelMethod): ResolvedChannelDefinition {
  const name = channelNameForMethod(method);
  return {
    name,
    method,
    urlPath: EVE_CALLBACK_ROUTE_PATTERN,
    fetch: handleSessionCallbackRequest,
    logicalPath: `framework://channels/${name}`,
    sourceId: `eve:framework:session-callback-${method.toLowerCase()}`,
    sourceKind: "module",
  };
}

function channelNameForMethod(method: ChannelMethod): string {
  return `${HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX}/${method.toLowerCase()}`;
}

export async function handleSessionCallbackRequest(
  request: Request,
  ctx: RouteContext,
): Promise<Response> {
  const token = ctx.params.token;
  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "Missing callback token.", ok: false }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body.", ok: false }, { status: 400 });
  }

  // The relay lane (issue #1170): notification-class events, handled inline
  // in this request's compute — no run, no hook, no queue wake. The
  // validated notification runs the channel's existing adapter event
  // handler and is appended to the session's durable stream for followers.
  // Once the payload is well-formed the response is always 202: a finished
  // session means nobody is rendering (log, drop). Nothing retries.
  if (token.endsWith(EVENT_INGESTION_TOKEN_SUFFIX)) {
    const wrapped = projectWrappedNotificationEvent(body);
    if (wrapped instanceof Response) {
      return wrapped;
    }
    const sessionId = token.slice(0, -EVENT_INGESTION_TOKEN_SUFFIX.length);
    try {
      await ingestSessionNotification(sessionId, wrapped);
    } catch (error) {
      logError(log, "notification ingestion failed; event dropped", error, { sessionId });
    }
    return Response.json({ ok: true }, { status: 202 });
  }

  // The control lane: terminal callbacks resume the parked parent turn.
  const hookPayload = projectSessionCallbackHookPayload(body);
  if (hookPayload instanceof Response) {
    return hookPayload;
  }

  try {
    await resumeHook(token, hookPayload);
  } catch {
    return Response.json({ error: "Session callback not pending.", ok: false }, { status: 404 });
  }

  return Response.json({ ok: true }, { status: 202 });
}

const EVENT_INGESTION_TOKEN_SUFFIX = ":events";

const notificationAuthorizationChallengeSchema = z.object({
  displayName: z.string().optional(),
  expiresAt: z.string().optional(),
  instructions: z.string().optional(),
  url: z.string().optional(),
  userCode: z.string().optional(),
});

/**
 * The relay lane's event vocabulary (issue #1170). Payloads arrive from
 * outside this deployment and are re-emitted on the session stream, so they
 * validate to the exact shapes a follower knows how to render; unknown keys
 * are stripped.
 */
const notificationEventSchema = z.union([
  z.object({
    data: z.object({
      authorization: notificationAuthorizationChallengeSchema.optional(),
      description: z.string(),
      name: z.string(),
      sequence: z.number(),
      stepIndex: z.number(),
      turnId: z.string(),
      webhookUrl: z.string().optional(),
    }),
    type: z.literal("authorization.required"),
  }),
  z.object({
    data: z.object({
      authorization: notificationAuthorizationChallengeSchema.optional(),
      name: z.string(),
      outcome: z.enum(["authorized", "declined", "failed", "timed-out"]),
      reason: z.string().optional(),
      sequence: z.number(),
      stepIndex: z.number(),
      turnId: z.string(),
    }),
    type: z.literal("authorization.completed"),
  }),
]);

/**
 * Full notification POST body: correlation fields plus the enveloped event.
 * The whole payload is validated as one schema — `sessionId` is optional
 * (older callees omit it) and unknown top-level keys are stripped.
 */
const notificationCallbackPayloadSchema = z.object({
  callId: z.string().min(1),
  event: notificationEventSchema,
  sessionId: z.string().optional(),
  subagentName: z.string().min(1),
});

/**
 * Projects one notification POST into the wrapped `subagent.event` appended
 * to the session's durable stream — the canonical form both followers and
 * channel rendering read.
 */
function projectWrappedNotificationEvent(value: unknown): SubagentChildEventStreamEvent | Response {
  const parsed = notificationCallbackPayloadSchema.safeParse(value);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid notification callback payload.", ok: false },
      { status: 400 },
    );
  }

  const { callId, event: parsedEvent, sessionId, subagentName } = parsed.data;
  const event: SubagentAuthorizationEvent =
    parsedEvent.type === "authorization.required"
      ? { data: parsedEvent.data, type: "authorization.required" }
      : { data: parsedEvent.data, type: "authorization.completed" };

  return {
    data: {
      callId,
      childSessionId: sessionId ?? "",
      event,
      subagentName,
    },
    type: "subagent.event",
  };
}

function projectSessionCallbackHookPayload(value: unknown): HookPayload | Response {
  if (value === null || typeof value !== "object") {
    return Response.json({ error: "Expected a JSON object.", ok: false }, { status: 400 });
  }

  const payload = value as Partial<SessionCallbackPayload>;
  if (typeof payload.callId !== "string" || payload.callId.length === 0) {
    return Response.json({ error: "Missing callback callId.", ok: false }, { status: 400 });
  }
  if (typeof payload.subagentName !== "string" || payload.subagentName.length === 0) {
    return Response.json({ error: "Missing callback subagentName.", ok: false }, { status: 400 });
  }
  const event = payload.event;
  if (event === null || typeof event !== "object") {
    return Response.json({ error: "Missing callback event.", ok: false }, { status: 400 });
  }

  if (event.status === "termination") {
    return resultTermination({
      callId: payload.callId,
      event,
      subagentName: payload.subagentName,
    });
  }

  // "notification" (and the reserved "working"/"input_required") are the
  // relay lane, delivered via the :events ingestion branch above.
  return Response.json({ error: "Unsupported callback event status.", ok: false }, { status: 400 });
}

function resultTermination(input: {
  readonly callId: string;
  readonly event: Partial<SessionCallbackTerminationEvent>;
  readonly subagentName: string;
}): HookPayload | Response {
  const event = input.event;

  if (event.kind === "session.completed") {
    const base: RuntimeSubagentResultActionResult = {
      callId: input.callId,
      kind: "subagent-result",
      output: event.output ?? "",
      subagentName: input.subagentName,
    };
    const usage = parseCallbackUsage((event as { usage?: unknown }).usage);
    return {
      kind: "runtime-action-result",
      results: [usage === undefined ? base : { ...base, usage }],
    };
  }

  if (event.kind === "session.failed") {
    return {
      kind: "runtime-action-result",
      results: [
        {
          callId: input.callId,
          isError: true,
          kind: "subagent-result",
          output:
            event.error === undefined
              ? {
                  code: "REMOTE_AGENT_FAILED",
                  message: "Remote agent failed.",
                }
              : event.error,
          subagentName: input.subagentName,
        },
      ],
    };
  }

  return Response.json({ error: "Unsupported callback kind.", ok: false }, { status: 400 });
}

/**
 * TokenUsage arrives from a remote callee that may run a different eve version,
 * so it is validated independently and dropped — never rejected — when
 * malformed. The rest of the callback still resumes the parent.
 */
function parseCallbackUsage(value: unknown): TokenUsage | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = tokenUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
