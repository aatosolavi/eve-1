import { workflowInfo } from "@temporalio/workflow";

import { runSession, runTurn } from "../programs.js";
import type { TerminalOutcome, TurnOutcome } from "../types.js";
import { TemporalLoopBackend } from "./backend.js";
import type { TemporalSessionWorkflowInput, TemporalTurnWorkflowInput } from "./contracts.js";

export async function temporalSessionWorkflow(
  envelope: TemporalSessionWorkflowInput,
): Promise<TerminalOutcome> {
  const info = workflowInfo();
  assertWorkflowEnvelope(info.workflowId, info.taskQueue, envelope.executionId, envelope);
  const backend = new TemporalLoopBackend({
    executionId: envelope.executionId,
    kind: "session",
    sessionId: envelope.input.sessionId,
    streamLogId: envelope.streamLogId,
    taskQueue: envelope.taskQueue,
  });
  return await runSession(backend, envelope.input);
}

export async function temporalTurnWorkflow(
  envelope: TemporalTurnWorkflowInput,
): Promise<TurnOutcome> {
  const info = workflowInfo();
  assertWorkflowEnvelope(info.workflowId, info.taskQueue, envelope.executionId, envelope);
  if (info.parent === undefined) throw new Error("Temporal turn Workflow has no parent.");

  const backend = new TemporalLoopBackend({
    checkpoint: envelope.checkpoint,
    executionId: envelope.executionId,
    kind: "turn",
    parentWorkflowId: info.parent.workflowId,
    sessionId: envelope.input.state.sessionId,
    streamLogId: envelope.streamLogId,
    taskQueue: envelope.taskQueue,
  });
  return await runTurn(backend, envelope.input);
}

function assertWorkflowEnvelope(
  workflowId: string,
  actualTaskQueue: string,
  executionId: string,
  envelope: TemporalSessionWorkflowInput | TemporalTurnWorkflowInput,
): void {
  if (workflowId !== executionId) {
    throw new Error(`Temporal Workflow "${workflowId}" does not match "${executionId}".`);
  }
  if (actualTaskQueue !== envelope.taskQueue) {
    throw new Error(
      `Temporal task queue "${actualTaskQueue}" does not match "${envelope.taskQueue}".`,
    );
  }
}
