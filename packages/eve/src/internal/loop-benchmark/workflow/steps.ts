import { getStepMetadata, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
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
import type { RecordActor } from "#internal/loop-benchmark/contract.js";
import type { LoopBenchmarkRecorder } from "#internal/loop-benchmark/recorder.js";
import {
  createLoopBenchmarkRecorder,
  recordLoopBenchmarkInterval,
  scheduleLoopBenchmarkRecorderFlush,
} from "#internal/loop-benchmark/runtime-telemetry.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";

import type {
  CreateWorkflowBenchmarkSessionStepInput,
  ExecuteWorkflowBenchmarkTurnStepInput,
  WorkflowBenchmarkChildSettled,
  WorkflowBenchmarkParkAcceptedStepInput,
  WorkflowBenchmarkTurnResult,
} from "./contracts.js";

/** Creates the real eve session inside a Workflow step boundary. */
export async function createWorkflowBenchmarkSessionStep(
  input: CreateWorkflowBenchmarkSessionStepInput,
): Promise<CreateSessionOperationResult> {
  "use step";

  const { sampleId, ...operationInput } = input;
  const recorder = createWorkflowStepRecorder({
    actor: "worker",
    fallbackAttempt: `${input.sessionId}:benchmark-create-session`,
    sampleId,
  });

  try {
    return await recordLoopBenchmarkInterval(
      recorder,
      "session.create.operation",
      async () => await createSessionOperation(operationInput),
    );
  } finally {
    scheduleLoopBenchmarkRecorderFlush(recorder);
  }
}

/** Executes one real eve turn operation and publishes into the root Workflow stream. */
export async function executeWorkflowBenchmarkTurnStep(
  input: ExecuteWorkflowBenchmarkTurnStepInput,
): Promise<DurableStepResult> {
  "use step";

  const recorder = createWorkflowStepRecorder({
    actor: "worker",
    fallbackAttempt: `${input.sessionState.sessionId}:turn:${String(input.turnOrdinal)}:step:${String(input.stepOrdinal)}`,
    sampleId: input.sampleId,
  });
  const durableSession = requireSnapshot(input.sessionState);
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;

  try {
    const result = await recordLoopBenchmarkInterval(
      recorder,
      "turn.step.operation",
      async () =>
        await executeTurnStepOperation({
          createEventSink() {
            const openedWriter = input.parentWritable.getWriter();
            writer = openedWriter;
            return {
              async write(publication): Promise<void> {
                await recordLoopBenchmarkInterval(recorder, "event.publish", async () => {
                  await openedWriter.write(publication.encoded);
                });
                recorder?.observeEvent({
                  encodedBytes: publication.encoded.byteLength,
                  eventType: publication.event.type,
                  metaAt: publication.event.meta.at,
                  ordinal: publication.emissionOrdinal,
                  stage: "publish.ack",
                });
              },
            };
          },
          durableSession,
          input: input.input,
          serializedContext: input.serializedContext,
          sessionState: input.sessionState,
        }),
    );

    if (writer !== undefined) {
      writer.releaseLock();
      writer = undefined;
    }

    return result;
  } finally {
    writer?.releaseLock();
    scheduleLoopBenchmarkRecorderFlush(recorder);
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

/** Records the point at which the session has accepted its parked address. */
export async function recordWorkflowBenchmarkParkAcceptedStep(
  input: WorkflowBenchmarkParkAcceptedStepInput,
): Promise<void> {
  "use step";

  const recorder = createWorkflowStepRecorder({
    actor: "session",
    fallbackAttempt: `${input.sessionId}:turn:${String(input.turnOrdinal)}:park`,
    sampleId: input.sampleId,
  });
  recorder?.mark("session.rekey.accepted");
  recorder?.mark("runtime.park.accepted");
  scheduleLoopBenchmarkRecorderFlush(recorder);
}

function createWorkflowStepRecorder(input: {
  readonly actor: RecordActor;
  readonly fallbackAttempt: string;
  readonly sampleId: string | undefined;
}): LoopBenchmarkRecorder | undefined {
  let step: ReturnType<typeof getStepMetadata> | undefined;
  let workflow: ReturnType<typeof getWorkflowMetadata> | undefined;
  try {
    step = getStepMetadata();
    workflow = getWorkflowMetadata();
  } catch {
    // Direct tests execute the step body without a Workflow host.
  }
  const recorder = createLoopBenchmarkRecorder({
    actor: input.actor,
    attempt:
      step === undefined || workflow === undefined
        ? input.fallbackAttempt
        : `${workflow.workflowRunId}:${step.stepId}:attempt:${String(step.attempt)}`,
    hostRole: "worker",
    runtime: "workflow",
    sampleId: input.sampleId,
  });
  if (step !== undefined && workflow !== undefined) {
    recorder?.engine({
      attempt: step.attempt,
      kind: "workflow.step",
      stepId: step.stepId,
      workflowRunId: workflow.workflowRunId,
    });
  }
  return recorder;
}

function requireSnapshot(state: DurableSessionState): DurableSession {
  if (state.snapshot === undefined) {
    throw new Error("Workflow benchmark requires an embedded durable session snapshot.");
  }
  return state.snapshot.session;
}
