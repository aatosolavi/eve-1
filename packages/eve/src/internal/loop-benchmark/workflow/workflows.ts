import { createHook, getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-state.js";
import type { SessionDeliveryHook } from "#internal/workflow/session-delivery-hook.js";
import { createSessionDeliveryHook } from "#internal/workflow/session-delivery-hook.js";
import {
  claimHookOwnership,
  closeHookIterator,
  disposeHook,
} from "#internal/workflow/hook-ownership.js";
import { start } from "#internal/workflow/runtime.js";

import type {
  WorkflowBenchmarkChildSettled,
  WorkflowBenchmarkSessionInput,
  StartWorkflowBenchmarkTurnStepResult,
  WorkflowBenchmarkTurnInput,
  WorkflowBenchmarkTurnResult,
} from "./contracts.js";
import {
  awaitWorkflowBenchmarkTurnResultStep,
  createWorkflowBenchmarkSessionStep,
  executeWorkflowBenchmarkTurnStep,
  recordWorkflowBenchmarkParkAcceptedStep,
  sendWorkflowBenchmarkChildSettledStep,
} from "./steps.js";

/** Long-lived benchmark session Workflow that owns delivery and stream lifetime. */
export async function workflowBenchmarkSession(
  input: WorkflowBenchmarkSessionInput,
): Promise<void> {
  "use workflow";

  const sessionId = getWorkflowMetadata().workflowRunId;
  const serializedContext = {
    ...input.serializedContext,
    "eve.sessionId": sessionId,
  };
  const parentWritable = getWritable<Uint8Array>();
  const bufferedDeliveries: DeliverHookPayload[] = [];
  const deliveryHook = createSessionDeliveryHook(bufferedDeliveries);

  try {
    await deliveryHook.rekey(input.continuationToken);
    const created = await createWorkflowBenchmarkSessionStep({
      compiledArtifactsSource: input.compiledArtifactsSource,
      continuationToken: input.continuationToken,
      nodeId: input.nodeId,
      sampleId: input.sampleId,
      sessionId,
    });

    let sessionState = created.state;
    let currentContext: Record<string, unknown> = serializedContext;
    let delivery: HookPayload = input.initialDelivery;
    let turnOrdinal = 0;

    while (true) {
      const result = await dispatchTurnChild({
        delivery,
        parentWritable,
        sampleId: input.sampleId,
        serializedContext: currentContext,
        sessionId,
        sessionState,
        turnOrdinal,
      });
      sessionState = result.sessionState;
      currentContext = result.serializedContext;

      if (result.action === "done") return;

      assertSupportedPark(result);
      await deliveryHook.rekey(result.sessionState.continuationToken);
      await recordWorkflowBenchmarkParkAcceptedStep({
        sampleId: input.sampleId,
        sessionId,
        turnOrdinal,
      });
      const nextDelivery = await receiveNextDelivery(deliveryHook, bufferedDeliveries);
      if (nextDelivery === null) return;
      delivery = nextDelivery;
      turnOrdinal += 1;
    }
  } finally {
    await deliveryHook.dispose();
  }
}

/** Child Workflow that owns one logical turn and returns only at a turn boundary. */
export async function workflowBenchmarkTurn(
  input: WorkflowBenchmarkTurnInput,
): Promise<WorkflowBenchmarkTurnResult> {
  "use workflow";

  const runId = getWorkflowMetadata().workflowRunId;
  let sessionState = input.sessionState;
  let serializedContext = input.serializedContext;
  let stepInput: HookPayload | undefined = input.initialInput;
  let stepOrdinal = 0;

  try {
    while (true) {
      const result = await executeWorkflowBenchmarkTurnStep({
        input: stepInput,
        parentWritable: input.parentWritable,
        sampleId: input.sampleId,
        serializedContext,
        sessionState,
        stepOrdinal,
        turnOrdinal: input.turnOrdinal,
      });
      sessionState = result.sessionState;
      serializedContext = result.serializedContext;

      switch (result.action) {
        case "continue":
          stepInput = undefined;
          stepOrdinal += 1;
          break;
        case "done":
          return { ...result, action: "done" };
        case "park":
          assertSupportedPark(result);
          return result;
        case "dispatch-workflow-runtime-actions":
          throw new Error("Workflow benchmark does not support workflow runtime actions.");
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    }
  } finally {
    await sendWorkflowBenchmarkChildSettledStep({
      notice: { kind: "turn-settled", runId, turnOrdinal: input.turnOrdinal },
      token: input.settledToken,
    });
  }
}

/** Starts the version-pinned child represented by this transformed Workflow function. */
export async function startWorkflowBenchmarkTurnStep(
  input: WorkflowBenchmarkTurnInput,
): Promise<StartWorkflowBenchmarkTurnStepResult> {
  "use step";

  const run = await start(workflowBenchmarkTurn, [input]);
  return { runId: run.runId };
}

async function dispatchTurnChild(input: {
  readonly delivery: HookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly sampleId?: string;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly turnOrdinal: number;
}): Promise<WorkflowBenchmarkTurnResult> {
  const token = `${input.sessionId}:benchmark-turn:${String(input.turnOrdinal)}:settled`;
  const settled = createHook<WorkflowBenchmarkChildSettled>({ token });
  const iterator = settled[Symbol.asyncIterator]();
  let ownsHook = false;

  try {
    await claimHookOwnership(settled);
    ownsHook = true;
    const { runId } = await startWorkflowBenchmarkTurnStep({
      initialInput: input.delivery,
      parentWritable: input.parentWritable,
      sampleId: input.sampleId,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
      settledToken: token,
      turnOrdinal: input.turnOrdinal,
    });
    const notice = await iterator.next();
    requireMatchingSettledNotice(notice, runId, input.turnOrdinal);
    return await awaitWorkflowBenchmarkTurnResultStep({ runId });
  } finally {
    await closeHookIterator(iterator);
    if (ownsHook) await disposeHook(settled);
  }
}

async function receiveNextDelivery(
  hook: SessionDeliveryHook,
  buffered: DeliverHookPayload[],
): Promise<DeliverHookPayload | null> {
  const ready = buffered.shift();
  if (ready !== undefined) return ready;

  while (true) {
    const next = await hook.next();
    hook.consumeNext();
    if (next.done) return null;
    if (next.value.kind === "deliver") return next.value;
  }
}

function assertSupportedPark(
  result: Extract<
    import("#execution/turn-step-operation.js").DurableStepResult,
    { readonly action: "park" }
  >,
): void {
  if (result.hasPendingAuthorization) {
    throw new Error("Workflow benchmark does not support authorization waits.");
  }
  if (result.hasPendingInputBatch) {
    throw new Error("Workflow benchmark does not support input-request waits.");
  }
  if (result.pendingRuntimeActionKeys !== undefined) {
    throw new Error("Workflow benchmark does not support runtime actions.");
  }
}

function requireMatchingSettledNotice(
  notice: IteratorResult<WorkflowBenchmarkChildSettled>,
  runId: string,
  turnOrdinal: number,
): void {
  if (notice.done) {
    throw new Error(`Workflow benchmark turn "${runId}" closed its settlement hook early.`);
  }
  if (
    notice.value.kind !== "turn-settled" ||
    notice.value.runId !== runId ||
    notice.value.turnOrdinal !== turnOrdinal
  ) {
    throw new Error(`Workflow benchmark turn "${runId}" sent mismatched settlement metadata.`);
  }
}
