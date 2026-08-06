/**
 * Sends delegated task results to their parent and conversation results to
 * the caller of each turn.
 */

import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { deserializeContext } from "#context/serialize.js";
import { parseSessionCallback } from "#channel/session-callback.js";
import type { TurnCaller } from "#channel/types.js";
import type {
  RuntimeInheritedSandboxResult,
  RuntimeSubagentChildResult,
} from "#runtime/actions/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { SessionCallbackKey } from "#context/keys.js";
import {
  isSubagentAdapterState,
  SUBAGENT_ADAPTER_KIND,
} from "#execution/subagent-adapter-state.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { SUBAGENT_EXECUTION_FAILED } from "#harness/agent-handle-errors.js";
import { createLogger } from "#internal/logging.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";

const log = createLogger("execution.delegated-parent-notification");

/**
 * Resumes the parent driver's hook with a delegated subagent result.
 * No-op for root sessions.
 *
 * `usage` — the completed child's session-total token spend — is
 * attached to success results so the caller can attribute the
 * subagent's tokens. Error results never carry usage.
 */
export async function notifyDelegatedParentStep(input: {
  readonly result: RuntimeSubagentChildResult | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState?: DurableSessionState;
  readonly usage?: TokenUsage;
}): Promise<void> {
  "use step";

  if (input.result === undefined) {
    return;
  }

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.get(ChannelKey);

  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND) {
    return;
  }

  const parentContinuationToken = String(adapter.state?.parentContinuationToken ?? "");
  if (parentContinuationToken === "") {
    return;
  }

  // A task child reports its session totals exactly once, so those totals
  // are the turn's usage delta; the terminal envelope carries them so the
  // parent folds spend from the outcome alone.
  const resultWithUsage =
    input.usage === undefined || input.result.isError === true
      ? input.result
      : {
          ...input.result,
          outcome: { ...input.result.outcome, usageDelta: input.usage },
          usage: input.usage,
        };
  const result = await attachInheritedSandboxResult({
    adapterState: adapter.state,
    result: resultWithUsage,
    sessionState: input.sessionState,
  });

  await resumeHook(parentContinuationToken, {
    kind: "runtime-action-result",
    results: [result],
  });
}

async function attachInheritedSandboxResult(input: {
  readonly adapterState: Readonly<Record<string, unknown>> | undefined;
  readonly result: RuntimeSubagentChildResult;
  readonly sessionState: DurableSessionState | undefined;
}): Promise<RuntimeSubagentChildResult> {
  if (input.sessionState === undefined) {
    return input.result;
  }

  const inheritedSandbox = await readInheritedSandboxResult({
    adapterState: input.adapterState,
    sessionState: input.sessionState,
  });

  if (inheritedSandbox === undefined) {
    return input.result;
  }

  return { ...input.result, inheritedSandbox };
}

async function readInheritedSandboxResult(input: {
  readonly adapterState: Readonly<Record<string, unknown>> | undefined;
  readonly sessionState: DurableSessionState;
}): Promise<RuntimeInheritedSandboxResult | undefined> {
  // Only children that share a sandbox carry sandboxSessionId. Isolation
  // paths omit it and must not backfill parent sandbox state.
  const sandboxSessionId = readNonEmptyString(input.adapterState?.sandboxSessionId);
  if (sandboxSessionId === undefined) {
    return undefined;
  }

  // sessionId is the *intended recipient* (immediate parent), not the
  // sandbox owner. Nested inherit.sandbox chains keep sandboxSessionId as
  // the root owner while parentSessionId points at the waiting parent;
  // applyInheritedSandboxResults matches this against the receiving
  // harness session id so mid-chain parents accept the backfill.
  const parentSessionId = readNonEmptyString(input.adapterState?.parentSessionId);
  if (parentSessionId === undefined) {
    return undefined;
  }

  const session = await readDurableSession(input.sessionState);

  if (session.sandboxState === undefined) {
    return undefined;
  }

  const inheritedSandbox: {
    nodeId?: string;
    sessionId: string;
    state: NonNullable<typeof session.sandboxState>;
  } = {
    sessionId: parentSessionId,
    state: session.sandboxState,
  };
  const sandboxNodeId = readNonEmptyString(input.adapterState?.sandboxNodeId);

  if (sandboxNodeId !== undefined) {
    inheritedSandbox.nodeId = sandboxNodeId;
  }

  return inheritedSandbox;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Settled turn payload forwarded from the driver to the caller. */
export interface SettledTurnNotification {
  readonly output: unknown;
  readonly isError?: boolean;
  /** Usage this turn added; omitted (zero) on crash and expiry paths. */
  readonly usage?: TokenUsage;
}

const ZERO_TOKEN_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/**
 * Sends a settled conversation turn to the caller that started it.
 *
 * `lifecycle` is the child engine's explicit verdict — `parked` when the
 * child session survived the turn and can accept another delivery,
 * `terminal` when it ended with this turn. It is carried on the result as
 * an {@link AgentTurnOutcome} so the caller never infers lifecycle from
 * success or error codes.
 */
export async function notifyTurnCallerStep(input: {
  readonly caller: TurnCaller | undefined;
  readonly lifecycle: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly settled: SettledTurnNotification;
}): Promise<void> {
  "use step";

  if (input.caller === undefined) {
    return;
  }

  const result = createSettledTurnResult({
    caller: input.caller,
    lifecycle: input.lifecycle,
    sessionId: input.sessionId,
    settled: input.settled,
  });

  if (input.caller.replyTo.kind === "callback") {
    await postSettledTurnCallback({
      result,
      sessionId: input.sessionId,
      url: input.caller.replyTo.url,
    });
    return;
  }

  await resumeSettledTurnHook(input.caller.replyTo.token, result);
}

function createSettledTurnResult(input: {
  readonly caller: TurnCaller;
  readonly lifecycle: AgentTurnOutcome["kind"];
  readonly sessionId: string;
  readonly settled: SettledTurnNotification;
}): RuntimeSubagentChildResult {
  const usageDelta = input.settled.usage ?? ZERO_TOKEN_USAGE;

  if (input.settled.isError === true) {
    const error = {
      code: SUBAGENT_EXECUTION_FAILED,
      message: toErrorMessage(input.settled.output),
    };
    return {
      callId: input.caller.callId,
      isError: true,
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: input.lifecycle,
        result: { error, kind: "failed" },
        usageDelta,
      },
      output: error,
      subagentName: input.caller.subagentName,
    };
  }

  const output = parseJsonValue(input.settled.output);
  const result: RuntimeSubagentChildResult = {
    callId: input.caller.callId,
    kind: "subagent-result",
    origin: "child",
    outcome: {
      kind: input.lifecycle,
      result: { kind: "succeeded", output },
      usageDelta,
    },
    output,
    subagentName: input.caller.subagentName,
  };
  // Legacy per-result usage projection (usage spans); the parent folds
  // `outcome.usageDelta`, never this field, when an outcome is present.
  return input.settled.usage === undefined ? result : { ...result, usage: input.settled.usage };
}

/** Resolves the caller that created a delegated conversation session. */
export async function resolveInitialTurnCallerStep(input: {
  readonly serializedContext: Record<string, unknown>;
}): Promise<TurnCaller | undefined> {
  "use step";

  const callbackValue = input.serializedContext[SessionCallbackKey.name];
  if (callbackValue !== undefined) {
    const parsed = parseSessionCallback(callbackValue);
    if (!parsed.ok) {
      throw new Error("Serialized session callback is invalid.", {
        cause: parsed.cause,
      });
    }
    return {
      callId: parsed.callback.callId,
      replyTo: { kind: "callback", url: parsed.callback.url },
      subagentName: parsed.callback.subagentName,
    };
  }

  const ctx = await deserializeContext(input.serializedContext);
  const adapter = ctx.get(ChannelKey);
  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND || !isSubagentAdapterState(adapter.state)) {
    return undefined;
  }

  return {
    callId: adapter.state.callId,
    replyTo: { kind: "hook", token: adapter.state.parentContinuationToken },
    subagentName: adapter.state.subagentName,
  };
}

async function postSettledTurnCallback(input: {
  readonly result: RuntimeSubagentChildResult;
  /** Informational on the wire (tracing); the receiver never verifies it. */
  readonly sessionId: string;
  readonly url: string;
}): Promise<void> {
  const { sessionId } = input;
  if (input.result.isError === true) {
    await postCallbackPayload({
      payload: {
        callId: input.result.callId,
        error: input.result.output,
        kind: "turn.failed",
        outcome: input.result.outcome,
        sessionId,
        subagentName: input.result.subagentName,
      },
      url: input.url,
    });
    return;
  }

  await postCallbackPayload({
    payload: {
      callId: input.result.callId,
      kind: "turn.completed",
      outcome: input.result.outcome,
      output: input.result.output,
      sessionId,
      subagentName: input.result.subagentName,
    },
    url: input.url,
  });
}

async function postCallbackPayload(input: {
  readonly payload: unknown;
  readonly url: string;
}): Promise<void> {
  const response = await postSessionCallbackRequest({
    body: input.payload,
    url: input.url,
  });

  if (!response.ok) {
    throw new Error(`Turn callback failed with HTTP ${response.status}.`);
  }
}

async function resumeSettledTurnHook(
  token: string,
  result: RuntimeSubagentChildResult,
): Promise<void> {
  try {
    await resumeHook(token, {
      kind: "runtime-action-result",
      results: [result],
    });
  } catch (error) {
    if (!HookNotFoundError.is(error)) {
      throw error;
    }

    log.warn("turn caller hook no longer exists", {
      callId: result.callId,
      callerToken: token,
    });
  }
}
