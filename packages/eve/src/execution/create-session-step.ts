import {
  createSessionOperation,
  type CreateSessionOperationInput,
  type CreateSessionOperationResult,
} from "#execution/session-operation.js";
import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import {
  createLoopBenchmarkRecorder,
  recordLoopBenchmarkInterval,
  scheduleLoopBenchmarkRecorderFlush,
} from "#internal/loop-benchmark/runtime-telemetry.js";

export interface CreateSessionStepInput extends CreateSessionOperationInput {
  readonly benchmarkSampleId?: string;
}

/**
 * Result returned by {@link createSessionStep}.
 *
 * Exposes the projected durable session state the driver needs to drive
 * the turn loop.
 */
export interface CreateSessionStepResult {
  readonly state: CreateSessionOperationResult["state"];
}

/**
 * Creates the durable session and returns the initial snapshot-bearing
 * state before the workflow enters its turn loop.
 * `nodeId` targets a subagent node in the compiled graph; omitted for
 * the root agent.
 */
export async function createSessionStep(
  input: CreateSessionStepInput,
): Promise<CreateSessionStepResult> {
  "use step";

  const { benchmarkSampleId, ...operationInput } = input;
  const attempt = readWorkflowStepAttempt(`${input.sessionId}:workflow-create-session`);
  const telemetry = createLoopBenchmarkRecorder({
    actor: "worker",
    attempt,
    hostRole: "worker",
    runtime: "workflow",
    sampleId: benchmarkSampleId,
  });

  try {
    const result =
      telemetry === undefined
        ? await createSessionOperation(operationInput)
        : await recordLoopBenchmarkInterval(
            telemetry,
            "session.create.operation",
            async () => await createSessionOperation(operationInput),
          );
    scheduleLoopBenchmarkRecorderFlush(telemetry);
    return result;
  } catch (error) {
    scheduleLoopBenchmarkRecorderFlush(telemetry);
    throw error;
  }
}

function readWorkflowStepAttempt(fallback: string): string {
  try {
    const metadata = getStepMetadata();
    return `${fallback}:${metadata.stepId}:attempt:${String(metadata.attempt)}`;
  } catch {
    return fallback;
  }
}
