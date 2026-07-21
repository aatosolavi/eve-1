import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import type { DurableSession, DurableSessionState } from "#execution/durable-session-state.js";
import {
  createSessionOperation,
  type CreateSessionOperationResult,
} from "#execution/session-operation.js";
import {
  executeTurnStepOperation,
  type DurableStepResult,
} from "#execution/turn-step-operation.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";

import type {
  CreateWorkflowBenchmarkSessionStepInput,
  ExecuteWorkflowBenchmarkTurnStepInput,
  WorkflowBenchmarkChildSettled,
  WorkflowBenchmarkTurnResult,
} from "./contracts.js";

/** Creates the real eve session inside a Workflow step boundary. */
export async function createWorkflowBenchmarkSessionStep(
  input: CreateWorkflowBenchmarkSessionStepInput,
): Promise<CreateSessionOperationResult> {
  "use step";

  return await createSessionOperation(input);
}

/** Executes one real eve turn operation and publishes into the root Workflow stream. */
export async function executeWorkflowBenchmarkTurnStep(
  input: ExecuteWorkflowBenchmarkTurnStepInput,
): Promise<DurableStepResult> {
  "use step";

  const durableSession = requireSnapshot(input.sessionState);
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;

  try {
    const result = await executeTurnStepOperation({
      createEventSink() {
        const openedWriter = input.parentWritable.getWriter();
        writer = openedWriter;
        return {
          async write(publication): Promise<void> {
            await openedWriter.write(publication.encoded);
          },
        };
      },
      durableSession,
      input: input.input,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
      writeEveAttributes: setEveAttributes,
    });

    if (writer !== undefined) {
      writer.releaseLock();
      writer = undefined;
    }

    return result;
  } finally {
    writer?.releaseLock();
  }
}

/** Reads the authoritative result after the child has announced settlement. */
export async function awaitWorkflowBenchmarkTurnResultStep(input: {
  readonly runId: string;
}): Promise<WorkflowBenchmarkTurnResult> {
  "use step";

  return await getRun<WorkflowBenchmarkTurnResult>(input.runId).returnValue;
}

/** Wakes the parent after the child has reached its return boundary. */
export async function sendWorkflowBenchmarkChildSettledStep(input: {
  readonly notice: WorkflowBenchmarkChildSettled;
  readonly token: string;
}): Promise<void> {
  "use step";

  try {
    await resumeHook(input.token, input.notice);
  } catch (error) {
    if (getStepMetadata().attempt > 1 && HookNotFoundError.is(error)) return;
    throw error;
  }
}

function requireSnapshot(state: DurableSessionState): DurableSession {
  if (state.snapshot === undefined) {
    throw new Error("Workflow benchmark requires an embedded durable session snapshot.");
  }
  return state.snapshot.session;
}
