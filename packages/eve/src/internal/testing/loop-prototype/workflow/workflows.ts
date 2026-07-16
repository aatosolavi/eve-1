import {
  defineHook,
  FatalError,
  getStepMetadata,
  getWorkflowMetadata,
  getWritable,
  type Hook,
} from "#compiled/@workflow/core/index.js";

import { getRun, resumeHook, start } from "#internal/workflow/runtime.js";

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
import { runSession, runTurn } from "../programs.js";
import { DeclaredEffectFailure, EffectProtocolError, SqlitePrototypeService } from "../service.js";
import type {
  ApprovalRequest,
  ChildHandle,
  ChildId,
  DelegatedSessionInput,
  Delivery,
  EffectCall,
  EffectResult,
  EventLogId,
  EventRecord,
  ExecutionId,
  GenerateInput,
  GeneratedTurn,
  LoopBackend,
  PrototypeStartInput,
  RequestResult,
  SessionCheckpoint,
  SessionId,
  SessionProgramInput,
  SessionState,
  Stream,
  StreamEvent,
  TerminalOutcome,
  ToolRequest,
  TurnHandle,
  TurnOutcome,
  TurnProgramInput,
} from "../types.js";

export interface WorkflowEventEnvelope {
  readonly event: EventRecord;
  readonly kind: "prototype-event";
}

interface WorkflowSessionInput {
  readonly continuationToken: string;
  readonly databasePath: string;
  readonly executionId: ExecutionId;
  readonly parent:
    | { readonly kind: "root" }
    | { readonly childId: ChildId; readonly kind: "session-child"; readonly noticeToken: string };
  readonly programInput: SessionProgramInput;
  readonly routingIntent: "pinned";
  readonly streamLogId: EventLogId;
}

interface WorkflowTurnInput {
  readonly checkpoint: SessionCheckpoint;
  readonly databasePath: string;
  readonly eventWritable: WritableStream<WorkflowEventEnvelope>;
  readonly executionId: ExecutionId;
  readonly parent: {
    readonly childId: ChildId;
    readonly kind: "turn-child";
    readonly noticeToken: string;
  };
  readonly programInput: TurnProgramInput;
  readonly routingIntent: "latest-compatible";
  readonly streamLogId: EventLogId;
}

type WorkflowParent = WorkflowSessionInput["parent"] | WorkflowTurnInput["parent"];

type WorkflowChildNotice =
  | {
      readonly ackToken: string;
      readonly backendRunId: string;
      readonly checkpoint: SessionCheckpoint;
      readonly childId: ChildId;
      readonly kind: "checkpoint";
    }
  | {
      readonly backendRunId: string;
      readonly childId: ChildId;
      readonly kind: "settled";
    };

interface CheckpointAck {
  readonly childId: ChildId;
  readonly kind: "checkpoint-ack";
  readonly revision: number;
}

interface ChildControl {
  readonly hook: Hook<WorkflowChildNotice>;
  readonly iterator: AsyncIterator<WorkflowChildNotice>;
}

interface StartedChild {
  readonly backendRunId: string;
  readonly control: ChildControl;
}

const deliveryHook = defineHook<Delivery>();
const childNoticeHook = defineHook<WorkflowChildNotice>();
const checkpointAckHook = defineHook<CheckpointAck>();

export async function workflowSession(input: WorkflowSessionInput): Promise<TerminalOutcome> {
  "use workflow";

  const delivery = deliveryHook.create({ token: input.continuationToken });
  const deliveryIterator = delivery[Symbol.asyncIterator]();
  await claimHook(delivery);
  const backend = new WorkflowLoopBackend({
    backendRunId: getWorkflowMetadata().workflowRunId,
    databasePath: input.databasePath,
    delivery: { hook: delivery, iterator: deliveryIterator },
    eventWritable: getWritable<WorkflowEventEnvelope>(),
    executionId: input.executionId,
    parent: input.parent,
    sessionId: input.programInput.sessionId,
    streamLogId: input.streamLogId,
  });

  try {
    return await runSession(backend, input.programInput);
  } finally {
    if (input.parent.kind === "session-child") {
      await sendControlStep(input.parent.noticeToken, {
        backendRunId: getWorkflowMetadata().workflowRunId,
        childId: input.parent.childId,
        kind: "settled",
      });
    }
    await backend.dispose();
  }
}

export async function workflowTurn(input: WorkflowTurnInput): Promise<TurnOutcome> {
  "use workflow";

  const backend = new WorkflowLoopBackend({
    backendRunId: getWorkflowMetadata().workflowRunId,
    checkpoint: input.checkpoint,
    databasePath: input.databasePath,
    eventWritable: input.eventWritable,
    executionId: input.executionId,
    parent: input.parent,
    sessionId: input.programInput.state.sessionId,
    streamLogId: input.streamLogId,
  });

  try {
    return await runTurn(backend, input.programInput);
  } finally {
    await sendControlStep(input.parent.noticeToken, {
      backendRunId: getWorkflowMetadata().workflowRunId,
      childId: input.parent.childId,
      kind: "settled",
    });
    await backend.dispose();
  }
}

class WorkflowStream implements Stream {
  readonly #beforeAppend: () => Promise<void>;
  readonly #databasePath: string;
  readonly #logId: EventLogId;
  readonly #writable: WritableStream<WorkflowEventEnvelope>;

  constructor(
    databasePath: string,
    writable: WritableStream<WorkflowEventEnvelope>,
    logId: EventLogId,
    beforeAppend: () => Promise<void>,
  ) {
    this.#beforeAppend = beforeAppend;
    this.#databasePath = databasePath;
    this.#logId = logId;
    this.#writable = writable;
  }

  async append(event: StreamEvent): Promise<void> {
    await this.#beforeAppend();
    await appendEventStep(this.#databasePath, this.#writable, this.#logId, event);
  }
}

class WorkflowLoopBackend implements LoopBackend {
  readonly executionId: ExecutionId;
  readonly stream: Stream;
  readonly #backendRunId: string;
  readonly #childControls = new Set<ChildControl>();
  readonly #databasePath: string;
  readonly #delivery:
    | { readonly hook: Hook<Delivery>; readonly iterator: AsyncIterator<Delivery> }
    | undefined;
  readonly #eventWritable: WritableStream<WorkflowEventEnvelope>;
  readonly #parent: WorkflowParent;
  readonly #pendingChildStarts = new Set<Promise<StartedChild>>();
  readonly #sessionId: SessionId;
  readonly #streamLogId: EventLogId;
  #checkpoint: SessionCheckpoint | null;

  constructor(input: {
    readonly backendRunId: string;
    readonly checkpoint?: SessionCheckpoint;
    readonly databasePath: string;
    readonly delivery?: {
      readonly hook: Hook<Delivery>;
      readonly iterator: AsyncIterator<Delivery>;
    };
    readonly eventWritable: WritableStream<WorkflowEventEnvelope>;
    readonly executionId: ExecutionId;
    readonly parent: WorkflowParent;
    readonly sessionId: SessionId;
    readonly streamLogId: EventLogId;
  }) {
    this.#backendRunId = input.backendRunId;
    this.#checkpoint = input.checkpoint ?? null;
    this.#databasePath = input.databasePath;
    this.#delivery = input.delivery;
    this.#eventWritable = input.eventWritable;
    this.executionId = input.executionId;
    this.#parent = input.parent;
    this.#sessionId = input.sessionId;
    this.#streamLogId = input.streamLogId;
    this.stream = new WorkflowStream(
      input.databasePath,
      input.eventWritable,
      input.streamLogId,
      async () => await this.#flushChildStarts(),
    );
  }

  async checkpoint(state: SessionState): Promise<void> {
    const next =
      this.#checkpoint === null
        ? initialCheckpoint(this.executionId, state)
        : checkpointOwnedState(this.#checkpoint, this.executionId, state);
    await recordCheckpointStep(next);
    this.#checkpoint = next;

    if (this.#parent.kind !== "turn-child") return;
    const ackToken = `${this.#backendRunId}:checkpoint:${String(next.revision)}:ack`;
    const ack = checkpointAckHook.create({ token: ackToken });
    await claimHook(ack);
    try {
      await sendControlStep(this.#parent.noticeToken, {
        ackToken,
        backendRunId: this.#backendRunId,
        checkpoint: next,
        childId: this.#parent.childId,
        kind: "checkpoint",
      });
      const received = await ack;
      if (
        received.kind !== "checkpoint-ack" ||
        received.childId !== this.#parent.childId ||
        received.revision !== next.revision
      ) {
        throw new Error(`Turn checkpoint revision ${String(next.revision)} received a bad ack.`);
      }
    } finally {
      ack.dispose();
    }
  }

  async executeTool(request: ApprovalRequest | ToolRequest): Promise<RequestResult> {
    const call = createExecuteToolEffect(request);
    return readExecuteToolResult(call, await runEffectStep(this.#databasePath, call));
  }

  async finish(outcome: TerminalOutcome): Promise<void> {
    if (this.#checkpoint?.state.phase !== "terminal") {
      throw new Error("Workflow session finished without a terminal checkpoint.");
    }
    await finishSessionStep(this.#databasePath, this.#sessionId, outcome);
    const terminalOperation = operationId(
      this.#sessionId,
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
    return readGenerateResult(call, await runEffectStep(this.#databasePath, call));
  }

  async receive(): Promise<Delivery> {
    if (this.#delivery === undefined) {
      throw new Error("Turn workflows do not own the public delivery hook.");
    }
    const next = await this.#delivery.iterator.next();
    if (next.done) throw new Error("Public delivery hook closed while the session was parked.");
    return next.value;
  }

  spawnChild(input: DelegatedSessionInput): ChildHandle {
    if (this.#parent.kind !== "turn-child") {
      throw new Error("Only a turn workflow can start a delegated session.");
    }
    const id = requestChildId(this.executionId, input.requestId);
    const started = this.#trackChildStart(this.#startSessionChild(id, input));
    return {
      id,
      wait: async () => {
        const child = await started;
        try {
          await this.#waitForSettled(child.control, id, child.backendRunId);
          return await awaitSessionChildCompletionStep(child.backendRunId);
        } finally {
          await this.#closeControl(child.control);
        }
      },
    };
  }

  spawnTurn(input: TurnProgramInput): TurnHandle {
    if (this.#parent.kind === "turn-child") {
      throw new Error("A turn workflow cannot start another turn workflow.");
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
        await recordCheckpointStep(checkpoint);
        this.#checkpoint = checkpoint;
      },
    });
    const started = this.#trackChildStart(this.#startTurnChild(id, delegated, input));
    return {
      id,
      wait: async () => {
        const child = await started;
        try {
          while (true) {
            const notice = await nextChildNotice(child.control, id, child.backendRunId);
            if (notice.kind === "settled") {
              const outcome = await awaitTurnChildCompletionStep(child.backendRunId);
              await protocol.complete(outcome.state);
              return outcome;
            }
            const revision = await protocol.accept(notice.checkpoint);
            await sendControlStep(notice.ackToken, {
              childId: id,
              kind: "checkpoint-ack",
              revision,
            });
          }
        } finally {
          await this.#closeControl(child.control);
        }
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.#delivery !== undefined) {
      await closeHook(this.#delivery.hook, this.#delivery.iterator);
    }
    await Promise.all([...this.#childControls].map(async (control) => this.#closeControl(control)));
  }

  async #startSessionChild(
    id: ChildId,
    input: DelegatedSessionInput,
  ): Promise<{ readonly backendRunId: string; readonly control: ChildControl }> {
    const control = await this.#openChildControl(id);
    try {
      const started = await startSessionChildStep({
        continuationToken: `${input.sessionId}:input`,
        databasePath: this.#databasePath,
        executionId: executionId(id),
        parent: { childId: id, kind: "session-child", noticeToken: control.hook.token },
        programInput: sessionProgramInput(input),
        routingIntent: "pinned",
        streamLogId: eventLogId(`${input.sessionId}:events`),
      });
      return { backendRunId: started.backendRunId, control };
    } catch (error) {
      await this.#closeControl(control);
      throw error;
    }
  }

  async #flushChildStarts(): Promise<void> {
    const pending = [...this.#pendingChildStarts];
    await Promise.all(pending);
    for (const started of pending) this.#pendingChildStarts.delete(started);
  }

  #trackChildStart(started: Promise<StartedChild>): Promise<StartedChild> {
    this.#pendingChildStarts.add(started);
    return started;
  }

  async #startTurnChild(
    id: ChildId,
    checkpoint: SessionCheckpoint,
    input: TurnProgramInput,
  ): Promise<{ readonly backendRunId: string; readonly control: ChildControl }> {
    const control = await this.#openChildControl(id);
    try {
      await recordCheckpointStep(checkpoint);
      const started = await startTurnChildStep({
        checkpoint,
        databasePath: this.#databasePath,
        eventWritable: this.#eventWritable,
        executionId: executionId(id),
        parent: { childId: id, kind: "turn-child", noticeToken: control.hook.token },
        programInput: input,
        routingIntent: "latest-compatible",
        streamLogId: this.#streamLogId,
      });
      return { backendRunId: started.backendRunId, control };
    } catch (error) {
      await this.#closeControl(control);
      throw error;
    }
  }

  async #waitForSettled(control: ChildControl, id: ChildId, backendRunId: string): Promise<void> {
    const notice = await nextChildNotice(control, id, backendRunId);
    if (notice.kind === "checkpoint") {
      throw new Error(`Session child "${id}" reported a borrowed checkpoint.`);
    }
  }

  async #openChildControl(id: ChildId): Promise<ChildControl> {
    const hook = childNoticeHook.create({ token: `${this.#backendRunId}:child:${id}:notices` });
    const control = { hook, iterator: hook[Symbol.asyncIterator]() };
    try {
      await claimHook(hook);
      this.#childControls.add(control);
      return control;
    } catch (error) {
      await closeHook(control.hook, control.iterator);
      throw error;
    }
  }

  async #closeControl(control: ChildControl): Promise<void> {
    if (!this.#childControls.delete(control)) return;
    await closeHook(control.hook, control.iterator);
  }
}

export async function runEffectStep(databasePath: string, call: EffectCall): Promise<EffectResult> {
  "use step";

  const service = new SqlitePrototypeService(databasePath);
  try {
    return { kind: "succeeded", output: await service.effect(call) };
  } catch (error) {
    if (error instanceof EffectProtocolError) throw new FatalError(error.message);
    const attempt = getStepMetadata().attempt;
    if (error instanceof DeclaredEffectFailure) {
      if (call.retry.idempotency === "none" || attempt >= call.retry.maxAttempts) {
        return { error: effectFailure(error), kind: "exhausted" };
      }
      throw error;
    }
    if (attempt >= call.retry.maxAttempts) throw new FatalError(effectFailure(error).message);
    throw error;
  } finally {
    await service.close();
  }
}

export async function appendEventStep(
  databasePath: string,
  writable: WritableStream<WorkflowEventEnvelope>,
  logId: EventLogId,
  event: StreamEvent,
): Promise<void> {
  "use step";

  const service = new SqlitePrototypeService(databasePath);
  let record: EventRecord;
  try {
    record = await service.append(logId, event);
  } finally {
    await service.close();
  }
  const writer = writable.getWriter();
  try {
    await writer.write({ event: record, kind: "prototype-event" });
  } finally {
    writer.releaseLock();
  }
}

export async function finishSessionStep(
  databasePath: string,
  sessionId: SessionId,
  outcome: TerminalOutcome,
): Promise<void> {
  "use step";

  const service = new SqlitePrototypeService(databasePath);
  try {
    service.finish(sessionId, outcome);
  } finally {
    await service.close();
  }
}

export async function recordCheckpointStep(checkpoint: SessionCheckpoint): Promise<void> {
  "use step";
  if (checkpoint.version !== 1) {
    throw new FatalError(`Unsupported checkpoint version "${String(checkpoint.version)}".`);
  }
}

export async function startSessionChildStep(
  input: WorkflowSessionInput,
): Promise<{ readonly backendRunId: string }> {
  "use step";
  const run = await start(workflowSession, [input]);
  return { backendRunId: run.runId };
}

export async function startTurnChildStep(
  input: WorkflowTurnInput,
): Promise<{ readonly backendRunId: string }> {
  "use step";
  const run = await start(workflowTurn, [input]);
  return { backendRunId: run.runId };
}

export async function awaitSessionChildCompletionStep(
  backendRunId: string,
): Promise<TerminalOutcome> {
  "use step";
  return await getRun<TerminalOutcome>(backendRunId).returnValue;
}

export async function awaitTurnChildCompletionStep(backendRunId: string): Promise<TurnOutcome> {
  "use step";
  return await getRun<TurnOutcome>(backendRunId).returnValue;
}

export async function sendControlStep(
  token: string,
  payload: CheckpointAck | WorkflowChildNotice,
): Promise<void> {
  "use step";
  try {
    await resumeHook(token, payload);
  } catch (error) {
    if (getStepMetadata().attempt > 1 && isHookNotFoundError(error)) return;
    throw error;
  }
}

function sessionProgramInput(input: SessionProgramInput): SessionProgramInput {
  return {
    initialDelivery: input.initialDelivery,
    mode: input.mode,
    scenario: input.scenario,
    sessionId: input.sessionId,
  };
}

function effectFailure(error: unknown): { readonly code: string; readonly message: string } {
  return {
    code: "EFFECT_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function nextChildNotice(
  control: ChildControl,
  id: ChildId,
  backendRunId: string,
): Promise<WorkflowChildNotice> {
  const next = await control.iterator.next();
  if (next.done) throw new Error(`Child "${id}" closed its notice hook early.`);
  if (next.value.childId !== id || next.value.backendRunId !== backendRunId) {
    throw new Error(`Child "${id}" sent a notice with mismatched identity.`);
  }
  return next.value;
}

function isHookNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "HookNotFoundError"
  );
}

async function claimHook(hook: Hook<unknown>): Promise<void> {
  const conflict = await hook.getConflict();
  if (conflict !== null) {
    throw new Error(`Hook "${hook.token}" is already owned by run "${conflict.runId}".`);
  }
}

async function closeHook<T>(hook: Hook<T>, iterator: AsyncIterator<T>): Promise<void> {
  if (typeof iterator.return === "function") await iterator.return(undefined);
  hook.dispose();
}

export function workflowProgramInput(input: PrototypeStartInput): SessionProgramInput {
  return sessionProgramInput(input);
}
