import { createHook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";
import { runTurn, TASK_MODE_WAIT_ERROR_MESSAGE } from "#core/turn-program.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { sendTurnControlStep, type TurnInboxPayload } from "#execution/turn-control-protocol.js";
import {
  migrateTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import {
  createTurnCancellationControl,
  type TurnCancellationControl,
} from "#execution/turn-cancellation-control.js";
import { TurnExecutionCursor } from "#execution/turn-execution-cursor.js";
import { TurnLoopBackend } from "#execution/turn-loop-backend.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { turnStep } from "#execution/workflow-steps.js";
import { activeTurnId } from "#harness/active-turn-id.js";

// A cancelled turn settles by parking the session, so the cancel hook is
// only claimed where a park can land: conversation sessions always accept
// follow-up input, and task sessions can park only when a continuation
// token anchors them to a waiting parent (delegated subagents always have
// one). A root task run without one is unparkable, so it stays
// uncancellable rather than settling a cancel as `session.failed`.
function canSettleCancelledTurnAsPark(input: TurnWorkflowInput): boolean {
  return input.mode === "conversation" || input.stepInput.sessionState.continuationToken !== "";
}

export type { TurnWorkflowInput };

/**
 * Runs one complete logical turn, including child-agent waits when supported.
 *
 * The turn-owned path also owns turn cancellation: resuming the
 * session-scoped cancel hook (`{sessionId}:cancel`) mid-turn aborts the
 * signal serialized into every `turnStep` and settles the turn as
 * `turn.cancelled` → `session.waiting` — never as a failure. A late or
 * guard-mismatched cancel is a benign no-op.
 */
export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";

  const input = migrateTurnWorkflowInput(rawInput);

  if (input.driverCapabilities?.turnInbox !== true) {
    return runLegacyTurnWorkflow(input);
  }

  return runTurnOwnedWorkflow(input);
}

async function runTurnOwnedWorkflow(input: TurnWorkflowInput): Promise<void> {
  const inbox = createHook<TurnInboxPayload>({ token: `${input.completionToken}:inbox` });
  // Hook promises and iterators share one durable cursor. Create the iterator before
  // claiming so conflict replay is consumed by getConflict(), not a later iterator read.
  const iterator = inbox[Symbol.asyncIterator]();
  const cursor = new TurnExecutionCursor({
    controlToken: input.completionToken,
    parentWritable: input.stepInput.parentWritable,
    serializedContext: input.stepInput.serializedContext,
    sessionState: input.stepInput.sessionState,
  });
  const bufferedDeliveries: DeliverHookPayload[] = [];
  let ownsInbox = false;
  let cancellation: TurnCancellationControl | undefined;

  try {
    try {
      await claimHookOwnership(inbox);
      ownsInbox = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    // Claimed after the inbox claim so a losing duplicate run never
    // contends for the session cancel token.
    if (
      input.driverCapabilities?.cancelledTurnSettle === true &&
      canSettleCancelledTurnAsPark(input)
    ) {
      cancellation = await createTurnCancellationControl({
        expectedTurnId: activeTurnId(input.stepInput.sessionState.emissionState),
        sessionId: input.stepInput.sessionState.sessionId,
      });
    }

    const backend = new TurnLoopBackend({
      bufferedDeliveries,
      cancellation,
      cursor,
      inboxToken: inbox.token,
      iterator,
    });

    const outcome = await runTurn(backend, {
      capabilities: input.capabilities,
      delivery: input.stepInput.input,
      mode: input.mode,
      state: {
        durable: input.stepInput.sessionState,
        serializedContext: input.stepInput.serializedContext,
      },
    });

    if (outcome.kind === "cancelled") {
      // No `canPark` check here: that gate rejects model-authored waits
      // (`next: null`) in task mode, whereas a cancelled turn parks by
      // design and its parkability was already established when the
      // cancel hook was claimed (`canSettleCancelledTurnAsPark`). The
      // epilogue runs in the driver (`settleCancelledTurnStep`), not as
      // a step in this run, where queued cancel wakes could re-dispatch
      // it.
      await cancelDescendantTurnsStep({
        serializedContext: cursor.serializedContext,
        sessionState: cursor.sessionState,
      });
      await cancellation?.dispose();
      await cursor.finish(
        { sessionState: cursor.sessionState },
        { cancelled: true, kind: "park" },
        bufferedDeliveries,
      );
      return;
    }

    await cancellation?.dispose();

    if (outcome.kind === "done") {
      await cursor.finish(
        {
          serializedContext: outcome.state.serializedContext,
          sessionState: outcome.state.durable,
        },
        {
          kind: "done",
          output: outcome.output,
          isError: outcome.isError,
          usage: outcome.usage,
        },
        bufferedDeliveries,
      );
      return;
    }

    await cursor.finish(
      {
        serializedContext: outcome.state.serializedContext,
        sessionState: outcome.state.durable,
      },
      {
        authorizationNames: outcome.authorizationNames,
        kind: "park",
      },
      bufferedDeliveries,
    );
  } catch (error) {
    await cursor.send({ error: normalizeSerializableError(error), kind: "turn-error" });
    throw error;
  } finally {
    // Dispose-only teardown: `iterator.return()` would await a pending
    // durable read that never settles, leaving this run `running` forever
    // and its hooks unswept. The cancel token is disposed *before* each
    // terminal result publishes so the next turn's claim never races this
    // run's teardown; this backstop covers the error path.
    if (cancellation !== undefined) await cancellation.dispose();
    if (ownsInbox) await disposeHook(inbox);
  }
}

async function runLegacyTurnWorkflow(input: TurnWorkflowInput): Promise<void> {
  let currentStepInput: TurnStepInput = input.stepInput;

  try {
    while (true) {
      const result = await turnStep(currentStepInput);

      if (result.action === "done") {
        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: {
            action: {
              kind: "done",
              output: result.output ?? "",
              isError: result.isError,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
              usage: result.usage,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "dispatch-workflow-runtime-actions") {
        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: {
            action: {
              kind: "dispatch-workflow-runtime-actions",
              pendingActionKeys: result.pendingRuntimeActionKeys,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "park") {
        const pendingActionKeys = result.pendingRuntimeActionKeys;
        const canPark =
          pendingActionKeys !== undefined ||
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
          input.mode === "conversation";

        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

        const action: NextDriverAction =
          pendingActionKeys !== undefined
            ? {
                kind: "dispatch-runtime-actions",
                pendingActionKeys,
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
              }
            : {
                kind: "park",
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
                authorizationNames: result.authorizationNames,
              };

        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: { action, kind: "turn-result" },
        });
        return;
      }

      currentStepInput = {
        input: undefined,
        parentWritable: currentStepInput.parentWritable,
        serializedContext: result.serializedContext,
        sessionState: result.sessionState,
      };
    }
  } catch (error) {
    await sendTurnControlStep({
      controlToken: input.completionToken,
      payload: { error: normalizeSerializableError(error), kind: "turn-error" },
    });
    throw error;
  }
}
