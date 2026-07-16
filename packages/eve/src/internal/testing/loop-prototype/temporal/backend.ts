import type { ChildWorkflowHandle } from "@temporalio/workflow";
import {
  condition,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  startChild,
} from "@temporalio/workflow";

import {
  checkpointOwnedState,
  delegateCheckpoint,
  initialCheckpoint,
  TurnCheckpointProtocol,
} from "../checkpoint-protocol.js";
import {
  createExecuteToolEffect,
  createGenerateEffect,
  readExecuteToolResult,
  readGenerateResult,
} from "../effect-definitions.js";
import { childId, eventId, eventLogId, executionId, operationId, requestChildId } from "../ids.js";
import type {
  ApprovalRequest,
  ChildHandle,
  DelegatedSessionInput,
  Delivery,
  EventLogId,
  ExecutionId,
  GenerateInput,
  GeneratedTurn,
  LoopBackend,
  RequestResult,
  SessionCheckpoint,
  SessionId,
  SessionState,
  Stream,
  StreamEvent,
  TerminalOutcome,
  ToolRequest,
  TurnHandle,
  TurnProgramInput,
} from "../types.js";
import {
  TEMPORAL_SESSION_WORKFLOW,
  TEMPORAL_TURN_WORKFLOW,
  temporalChildAcknowledgedSignal,
  temporalChildUpdateSignal,
  temporalDeliverySignal,
} from "./contracts.js";
import type {
  TemporalActivities,
  TemporalSessionWorkflow,
  TemporalTurnWorkflow,
} from "./contracts.js";

type TemporalBackendContext =
  | {
      readonly executionId: ExecutionId;
      readonly kind: "session";
      readonly sessionId: SessionId;
      readonly streamLogId: EventLogId;
      readonly taskQueue: string;
    }
  | {
      readonly checkpoint: SessionCheckpoint;
      readonly executionId: ExecutionId;
      readonly kind: "turn";
      readonly parentWorkflowId: string;
      readonly sessionId: SessionId;
      readonly streamLogId: EventLogId;
      readonly taskQueue: string;
    };

type ChildTerminalState<Output> =
  | { readonly kind: "pending" }
  | { readonly kind: "resolved"; readonly output: Output }
  | { readonly error: unknown; readonly kind: "rejected" };

type TrackedChildWorkflow<Output> = ChildWorkflowHandle<() => Promise<Output>>;

class TemporalChildTracker<Output> {
  #terminal: ChildTerminalState<Output> = { kind: "pending" };
  readonly workflow: TrackedChildWorkflow<Output>;

  constructor(workflow: TrackedChildWorkflow<Output>) {
    this.workflow = workflow;
    void workflow.result().then(
      (output) => {
        this.#terminal = { kind: "resolved", output };
      },
      (error: unknown) => {
        this.#terminal = { error, kind: "rejected" };
      },
    );
  }

  get settled(): boolean {
    return this.#terminal.kind !== "pending";
  }

  result(): Output {
    switch (this.#terminal.kind) {
      case "pending":
        throw new Error(`Child Workflow "${this.workflow.workflowId}" has not completed.`);
      case "rejected":
        throw this.#terminal.error;
      case "resolved":
        return this.#terminal.output;
    }
  }
}

class TemporalStream implements Stream {
  readonly #activities: TemporalActivities;
  readonly #beforeAppend: () => Promise<void>;
  readonly #logId: EventLogId;

  constructor(taskQueue: string, logId: EventLogId, beforeAppend: () => Promise<void>) {
    this.#activities = activities(taskQueue, 2);
    this.#beforeAppend = beforeAppend;
    this.#logId = logId;
  }

  async append(event: StreamEvent): Promise<void> {
    await this.#beforeAppend();
    await this.#activities.appendEvent(this.#logId, event);
  }
}

export class TemporalLoopBackend implements LoopBackend {
  readonly executionId: ExecutionId;
  readonly stream: Stream;
  readonly #acknowledgedRevisions = new Set<number>();
  readonly #childUpdates = new Map<string, SessionCheckpoint[]>();
  readonly #context: TemporalBackendContext;
  readonly #deliveries: Delivery[] = [];
  readonly #pendingChildStarts = new Set<Promise<unknown>>();
  #checkpoint: SessionCheckpoint | null;

  constructor(context: TemporalBackendContext) {
    this.#context = context;
    this.#checkpoint = context.kind === "turn" ? context.checkpoint : null;
    this.executionId = context.executionId;
    this.stream = new TemporalStream(
      context.taskQueue,
      context.streamLogId,
      async () => await this.#flushChildStarts(),
    );

    setHandler(temporalDeliverySignal, (delivery) => {
      this.#deliveries.push(delivery);
    });
    setHandler(temporalChildUpdateSignal, ({ checkpoint, childWorkflowId }) => {
      const updates = this.#childUpdates.get(childWorkflowId) ?? [];
      updates.push(checkpoint);
      this.#childUpdates.set(childWorkflowId, updates);
    });
    setHandler(temporalChildAcknowledgedSignal, (revision) => {
      this.#acknowledgedRevisions.add(revision);
    });
  }

  async checkpoint(state: SessionState): Promise<void> {
    const next =
      this.#checkpoint === null
        ? initialCheckpoint(this.executionId, state)
        : checkpointOwnedState(this.#checkpoint, this.executionId, state);
    this.#checkpoint = next;
    if (this.#context.kind === "session") return;

    const parent = getExternalWorkflowHandle(this.#context.parentWorkflowId);
    await parent.signal(temporalChildUpdateSignal, {
      checkpoint: next,
      childWorkflowId: this.executionId,
    });
    await condition(() => this.#acknowledgedRevisions.has(next.revision));
    this.#acknowledgedRevisions.delete(next.revision);
  }

  async executeTool(request: ApprovalRequest | ToolRequest): Promise<RequestResult> {
    const call = createExecuteToolEffect(request);
    return readExecuteToolResult(
      call,
      await activities(this.#context.taskQueue, call.retry.maxAttempts).effect(call),
    );
  }

  async finish(outcome: TerminalOutcome): Promise<void> {
    if (this.#checkpoint?.state.phase !== "terminal") {
      throw new Error("Temporal session finished without a terminal checkpoint.");
    }
    await activities(this.#context.taskQueue, 2).finish(this.#context.sessionId, outcome);
    const terminalOperation = operationId(
      this.#context.sessionId,
      this.#checkpoint.state.nextTurnOrdinal,
      "finalize",
    );
    await this.stream.append({
      id: eventId(terminalOperation, 0),
      operationId: terminalOperation,
      payload: { outcome: outcome.kind, type: "session.terminal" },
    });
  }

  async generate(input: GenerateInput): Promise<GeneratedTurn> {
    const call = createGenerateEffect(input);
    return readGenerateResult(
      call,
      await activities(this.#context.taskQueue, call.retry.maxAttempts).effect(call),
    );
  }

  async receive(): Promise<Delivery> {
    await condition(() => this.#deliveries.length > 0);
    const delivery = this.#deliveries.shift();
    if (delivery === undefined) throw new Error("Temporal delivery disappeared.");
    return delivery;
  }

  spawnChild(input: DelegatedSessionInput): ChildHandle {
    if (this.#context.kind !== "turn") {
      throw new Error("Only a turn Workflow can start a delegated session.");
    }
    const id = requestChildId(this.executionId, input.requestId);
    const workflow = this.#trackChildStart(
      startChild<TemporalSessionWorkflow>(TEMPORAL_SESSION_WORKFLOW, {
        args: [
          {
            executionId: executionId(id),
            input: sessionProgramInput(input),
            kind: "session",
            routingIntent: "pinned",
            streamLogId: eventLogId(`${input.sessionId}:events`),
            taskQueue: this.#context.taskQueue,
          },
        ],
        memo: { eveRoutingIntent: "pinned" },
        taskQueue: this.#context.taskQueue,
        workflowId: id,
      }),
    );
    return {
      id,
      wait: async () => {
        const tracker = new TemporalChildTracker(await workflow);
        await condition(() => tracker.settled);
        return tracker.result();
      },
    };
  }

  spawnTurn(input: TurnProgramInput): TurnHandle {
    if (this.#context.kind !== "session") {
      throw new Error("A turn Workflow cannot start another turn Workflow.");
    }
    if (this.#checkpoint === null) throw new Error("Turn spawned before session initialization.");
    const id = childId(this.executionId, input.state.nextTurnOrdinal - 1, "turn");
    const childExecutionId = executionId(id);
    const delegated = delegateCheckpoint(this.#checkpoint, this.executionId, childExecutionId);
    this.#checkpoint = delegated;
    const protocol = new TurnCheckpointProtocol({
      child: childExecutionId,
      delegated,
      parent: this.executionId,
      persist: async (checkpoint) => {
        this.#checkpoint = checkpoint;
      },
    });
    const workflow = this.#trackChildStart(
      startChild<TemporalTurnWorkflow>(TEMPORAL_TURN_WORKFLOW, {
        args: [
          {
            checkpoint: delegated,
            executionId: childExecutionId,
            input,
            kind: "turn",
            routingIntent: "latest-compatible",
            streamLogId: this.#context.streamLogId,
            taskQueue: this.#context.taskQueue,
          },
        ],
        memo: { eveRoutingIntent: "latest-compatible" },
        taskQueue: this.#context.taskQueue,
        workflowId: id,
      }),
    );
    return {
      id,
      wait: async () => {
        const tracker = new TemporalChildTracker(await workflow);
        while (true) {
          await condition(() => this.#hasChildUpdate(id) || tracker.settled);
          const update = this.#takeChildUpdate(id);
          if (update !== null) {
            const revision = await protocol.accept(update);
            await tracker.workflow.signal(temporalChildAcknowledgedSignal, revision);
            continue;
          }
          const outcome = tracker.result();
          await protocol.complete(outcome.state);
          return outcome;
        }
      },
    };
  }

  #hasChildUpdate(childWorkflowId: string): boolean {
    return (this.#childUpdates.get(childWorkflowId)?.length ?? 0) > 0;
  }

  async #flushChildStarts(): Promise<void> {
    const pending = [...this.#pendingChildStarts];
    await Promise.all(pending);
    for (const started of pending) this.#pendingChildStarts.delete(started);
  }

  #trackChildStart<Value>(started: Promise<Value>): Promise<Value> {
    this.#pendingChildStarts.add(started);
    return started;
  }

  #takeChildUpdate(childWorkflowId: string): SessionCheckpoint | null {
    const updates = this.#childUpdates.get(childWorkflowId);
    if (updates === undefined) return null;
    const update = updates.shift() ?? null;
    if (updates.length === 0) this.#childUpdates.delete(childWorkflowId);
    return update;
  }
}

function activities(taskQueue: string, maximumAttempts: number): TemporalActivities {
  return proxyActivities<TemporalActivities>({
    retry: {
      backoffCoefficient: 1,
      initialInterval: "1 millisecond",
      maximumAttempts,
    },
    startToCloseTimeout: "30 seconds",
    taskQueue,
  });
}

function sessionProgramInput(input: DelegatedSessionInput) {
  return {
    initialDelivery: input.initialDelivery,
    mode: input.mode,
    scenario: input.scenario,
    sessionId: input.sessionId,
  };
}
