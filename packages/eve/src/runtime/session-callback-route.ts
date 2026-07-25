import { z } from "#compiled/zod/index.js";

import { createLogger, logError } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { EVE_CALLBACK_ROUTE_PATTERN } from "#protocol/routes.js";
import {
  PROGRESS_EVENT_TYPES,
  sessionCallbackNotificationEventSchema,
} from "#channel/session-callback.js";
import { appendSessionStreamEvent } from "#execution/session-stream-append.js";
import type {
  SessionCallbackPayload,
  SessionCallbackTerminationEvent,
} from "#channel/session-callback.js";
import type { HookPayload, SubagentAuthorizationEvent } from "#channel/types.js";
import type { HandleMessageStreamEvent, SubagentChildEventStreamEvent } from "#protocol/message.js";
import type { ChannelMethod, RouteContext } from "#public/definitions/channel.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import type { RuntimeSubagentResultActionResult } from "#runtime/actions/types.js";
import { tokenUsageSchema, type TokenUsage } from "#shared/token-usage.js";

export const HTTP_SESSION_CALLBACK_CHANNEL_NAME_PREFIX = "eve/v1/callback";

const log = createLogger("runtime.session-callback-route");

const PROGRESS_TOKEN_SUFFIX = ":events";

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

  // Best-effort progress lane (issue #1170): a callee's non-terminal
  // progress, appended to this session's stream wrapped as `subagent.event`
  // — no run, no hook, no resume, so it never inflates the main run's
  // replay journal. Always 202 once well-formed; a closed stream (session
  // over) logs and drops. Nothing retries.
  if (token.endsWith(PROGRESS_TOKEN_SUFFIX)) {
    const wrapped = projectWrappedProgressEvent(body);
    if (wrapped instanceof Response) {
      return wrapped;
    }
    const sessionId = token.slice(0, -PROGRESS_TOKEN_SUFFIX.length);
    try {
      await appendSessionStreamEvent(sessionId, wrapped);
    } catch (error) {
      logError(log, "progress append failed; event dropped", error, { sessionId });
    }
    return Response.json({ ok: true }, { status: 202 });
  }

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

const progressCallbackPayloadSchema = z.object({
  callId: z.string().min(1),
  event: z.object({
    // Progress is rendering-only, so the child event's data rides loosely —
    // it is not re-validated per type, only allow-listed by `type`.
    data: z.looseObject({}).optional(),
    type: z.enum(PROGRESS_EVENT_TYPES),
  }),
  sessionId: z.string().optional(),
  subagentName: z.string().min(1),
});

/**
 * Projects one progress POST into the wrapped `subagent.event` appended to
 * the caller's durable stream — the form followers read.
 */
function projectWrappedProgressEvent(value: unknown): SubagentChildEventStreamEvent | Response {
  const parsed = progressCallbackPayloadSchema.safeParse(value);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid progress callback payload.", ok: false },
      { status: 400 },
    );
  }

  const { callId, event, sessionId, subagentName } = parsed.data;
  return {
    data: {
      callId,
      childSessionId: sessionId ?? "",
      event: { data: event.data ?? {}, type: event.type } as HandleMessageStreamEvent,
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

  // A remote callee's authorization events are low-frequency control
  // events, so they ride the same durable resumeHook path as a local
  // subagent's: projected into a `subagent-authorization-event` and
  // resumed onto the parent turn inbox, where the turn workflow proxies
  // them onto the parent stream (workflow-entry, exactly as local). The
  // separate high-frequency progress lane is future work.
  if (event.status === "notification") {
    const parsed = sessionCallbackNotificationEventSchema.safeParse(event);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid notification callback event.", ok: false },
        { status: 400 },
      );
    }
    const authorizationEvent: SubagentAuthorizationEvent =
      parsed.data.type === "authorization.required"
        ? { data: parsed.data.data, type: "authorization.required" }
        : { data: parsed.data.data, type: "authorization.completed" };
    return {
      callId: payload.callId,
      childSessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      event: authorizationEvent,
      kind: "subagent-authorization-event",
      subagentName: payload.subagentName,
    };
  }

  // "working"/"input_required" remain reserved on the wire.
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
