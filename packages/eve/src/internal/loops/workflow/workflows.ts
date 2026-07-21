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
  WorkflowLoopChildSettled,
  WorkflowLoopSessionInput,
  StartWorkflowLoopTurnStepResult,
  WorkflowLoopTurnInput,
  WorkflowLoopTurnResult,
} from "./contracts.js";
import {
  awaitWorkflowLoopTurnResultStep,
  createWorkflowLoopSessionStep,
  executeWorkflowLoopTurnStep,
  sendWorkflowLoopChildSettledStep,
} from "./steps.js";

/** Long-lived loop session Workflow that owns delivery and stream lifetime. */
export async function workflowLoopSession(input: WorkflowLoopSessionInput): Promise<void> {
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
    const created = await createWorkflowLoopSessionStep({
      compiledArtifactsSource: input.compiledArtifactsSource,
      continuationToken: input.continuationToken,
      nodeId: input.nodeId,
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
export async function workflowLoopTurn(
  input: WorkflowLoopTurnInput,
): Promise<WorkflowLoopTurnResult> {
  "use workflow";

  const runId = getWorkflowMetadata().workflowRunId;
  let sessionState = input.sessionState;
  let serializedContext = input.serializedContext;
  let stepInput: HookPayload | undefined = input.initialInput;
  let stepOrdinal = 0;

  try {
    while (true) {
      const result = await executeWorkflowLoopTurnStep({
        input: stepInput,
        parentWritable: input.parentWritable,
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
          throw new Error("Workflow loop runtime does not support workflow runtime actions.");
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    }
  } finally {
    await sendWorkflowLoopChildSettledStep({
      notice: { kind: "turn-settled", runId, turnOrdinal: input.turnOrdinal },
      token: input.settledToken,
    });
  }
}

/** Starts the version-pinned child represented by this transformed Workflow function. */
export async function startWorkflowLoopTurnStep(
  input: WorkflowLoopTurnInput,
): Promise<StartWorkflowLoopTurnStepResult> {
  "use step";

  const run = await start(workflowLoopTurn, [input]);
  return { runId: run.runId };
}

async function dispatchTurnChild(input: {
  readonly delivery: HookPayload;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly turnOrdinal: number;
}): Promise<WorkflowLoopTurnResult> {
  const token = `${input.sessionId}:loop-turn:${String(input.turnOrdinal)}:settled`;
  const settled = createHook<WorkflowLoopChildSettled>({ token });
  const iterator = settled[Symbol.asyncIterator]();
  let ownsHook = false;

  try {
    await claimHookOwnership(settled);
    ownsHook = true;
    const { runId } = await startWorkflowLoopTurnStep({
      initialInput: input.delivery,
      parentWritable: input.parentWritable,
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
      settledToken: token,
      turnOrdinal: input.turnOrdinal,
    });
    const notice = await iterator.next();
    requireMatchingSettledNotice(notice, runId, input.turnOrdinal);
    return await awaitWorkflowLoopTurnResultStep({ runId });
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
    throw new Error("Workflow loop runtime does not support authorization waits.");
  }
  if (result.hasPendingInputBatch) {
    throw new Error("Workflow loop runtime does not support input-request waits.");
  }
  if (result.pendingRuntimeActionKeys !== undefined) {
    throw new Error("Workflow loop runtime does not support runtime actions.");
  }
}

function requireMatchingSettledNotice(
  notice: IteratorResult<WorkflowLoopChildSettled>,
  runId: string,
  turnOrdinal: number,
): void {
  if (notice.done) {
    throw new Error(`Workflow loop runtime turn "${runId}" closed its settlement hook early.`);
  }
  if (
    notice.value.kind !== "turn-settled" ||
    notice.value.runId !== runId ||
    notice.value.turnOrdinal !== turnOrdinal
  ) {
    throw new Error(`Workflow loop runtime turn "${runId}" sent mismatched settlement metadata.`);
  }
}
