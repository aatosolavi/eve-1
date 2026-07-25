import type { LoopTypes, TurnStepResult } from "#core/types.js";
import { getPendingAuthorization } from "#core/authorization.js";
import { hasPendingInputBatch } from "#core/input-requests.js";
import { getRuntimeActionRequestKey } from "#core/actions/keys.js";
import { getPendingRuntimeActionBatch } from "#core/runtime-actions.js";
import { getPendingWorkflowInterrupt } from "#core/workflow-interrupt-state.js";
import {
  getRuntimeActionKeysFromWorkflowInterrupt,
  isWorkflowRuntimeActionInterrupt,
} from "#core/workflow-runtime-action-state.js";
import type { GenerateOutcome, HarnessLoopTypes, HarnessSession } from "#harness/types.js";

/**
 * Outcome classification over parked session state, and the state
 * re-attachment used at every projection boundary.
 */

/**
 * Classifies a parked session into the {@link GenerateOutcome} arm the loop
 * consumes: an interrupted `Workflow` sandbox dispatches its runtime
 * actions, a pending runtime-action batch parks with its request keys
 * (unresolved child work), and anything else is a human wait carrying the
 * park metadata the settle phase reads.
 */
export function classifyParkedSession(session: HarnessSession): GenerateOutcome {
  const workflowInterrupt = getPendingWorkflowInterrupt(session.state);
  if (
    workflowInterrupt !== undefined &&
    isWorkflowRuntimeActionInterrupt(workflowInterrupt.interrupt)
  ) {
    return {
      action: "dispatch-workflow-runtime-actions",
      pendingRuntimeActionKeys: getRuntimeActionKeysFromWorkflowInterrupt(
        workflowInterrupt.interrupt,
      ),
      state: session,
    };
  }

  const pendingAuthorization = getPendingAuthorization(session.state);
  const parked = {
    action: "park" as const,
    authorizationNames: pendingAuthorization?.challenges.map((challenge) => challenge.name),
    hasPendingAuthorization: pendingAuthorization !== undefined,
    hasPendingInputBatch: hasPendingInputBatch(session.state),
    state: session,
  };

  const batch = getPendingRuntimeActionBatch(session.state);
  if (batch !== undefined) {
    return {
      ...parked,
      pendingRuntimeActionKeys: batch.actions.map((action) => getRuntimeActionRequestKey(action)),
    };
  }
  return parked;
}

/**
 * Re-attaches a different state to a classified outcome without changing
 * the classification — e.g. after provider commit rewrites the session, or
 * when the durable boundary projects the harness outcome onto the
 * serialized session cursors.
 */
export function withOutcomeState<
  To extends LoopTypes,
  From extends LoopTypes & { readonly usage: To["usage"] } = HarnessLoopTypes,
>(outcome: TurnStepResult<From>, state: To["state"]): TurnStepResult<To> {
  switch (outcome.action) {
    case "continue":
      return { action: "continue", state };
    case "done":
      return {
        action: "done",
        isError: outcome.isError,
        output: outcome.output,
        state,
        usage: outcome.usage,
      };
    case "cancelled":
      return { action: "cancelled", state };
    case "park":
      return {
        action: "park",
        authorizationNames: outcome.authorizationNames,
        hasPendingAuthorization: outcome.hasPendingAuthorization,
        hasPendingInputBatch: outcome.hasPendingInputBatch,
        pendingRuntimeActionKeys: outcome.pendingRuntimeActionKeys,
        state,
      };
    case "dispatch-workflow-runtime-actions":
      return {
        action: "dispatch-workflow-runtime-actions",
        pendingRuntimeActionKeys: outcome.pendingRuntimeActionKeys,
        state,
      };
  }
}
