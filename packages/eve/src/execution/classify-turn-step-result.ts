import type { Generated, LoopRequest, SessionState } from "#core/types.js";
import type { DurableStepResult } from "#execution/turn-step-operation.js";

/** Projects an engine-neutral step operation result into the shared turn program. */
export function classifyTurnStepResult(result: DurableStepResult): Generated {
  const state = toSessionState(result);

  if (result.action === "cancelled") return { kind: "cancelled", state };
  if (result.action === "done") {
    return {
      isError: result.isError,
      kind: "finish",
      output: result.output ?? "",
      state,
      usage: result.usage,
    };
  }
  if (result.action === "dispatch-workflow-runtime-actions") {
    return {
      kind: "requests",
      requests: toLoopRequests("workflow-interrupt", result.pendingRuntimeActionKeys),
      state,
    };
  }
  if (result.action === "park") {
    if (result.pendingRuntimeActionKeys !== undefined) {
      return {
        kind: "requests",
        requests: toLoopRequests("subagent", result.pendingRuntimeActionKeys),
        state,
      };
    }
    return {
      authorizationNames: result.authorizationNames,
      hasPendingAuthorization: result.hasPendingAuthorization,
      hasPendingInputBatch: result.hasPendingInputBatch,
      kind: "waiting",
      state,
    };
  }
  return { kind: "continue", state };
}

export function toSessionState(
  result: Pick<DurableStepResult, "serializedContext" | "sessionState">,
): SessionState {
  return { durable: result.sessionState, serializedContext: result.serializedContext };
}

function toLoopRequests(
  kind: LoopRequest["kind"],
  keys: readonly string[],
): readonly LoopRequest[] {
  return keys.map((key) => ({ key, kind }));
}
