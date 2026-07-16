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
import { DeclaredEffectFailure, MemoryPrototypeService } from "../service.js";
import type {
  ApprovalRequest,
  ChildHandle,
  DelegatedSessionInput,
  Delivery,
  EffectCall,
  EffectResult,
  EventLogId,
  ExecutionId,
  GenerateInput,
  GeneratedTurn,
  LoopBackend,
  OperationId,
  PrototypeRun,
  PrototypeRuntime,
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
  TurnProgramInput,
} from "../types.js";
import { AsyncQueue, InlineRunStoppedError } from "./async-queue.js";

export { InlineRunStoppedError } from "./async-queue.js";

interface StoppableQueue {
  stop(error: Error): void;
}

class InlineRunScope {
  readonly error = new InlineRunStoppedError();
  readonly #queues = new Set<StoppableQueue>();
  readonly #stopListeners = new Set<() => void>();
  #stopped = false;

  assertRunning(): void {
    if (this.#stopped) throw this.error;
  }

  queue<Value>(): AsyncQueue<Value> {
    const queue = new AsyncQueue<Value>();
    this.#queues.add(queue);
    return queue;
  }

  release(queue: StoppableQueue): void {
    this.#queues.delete(queue);
  }

  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.assertRunning();
    return await new Promise<Value>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        complete();
      };
      const stop = (): void => finish(() => reject(this.error));

      this.#stopListeners.add(stop);
      operation().then(
        (value) =>
          finish(() => {
            this.#stopListeners.delete(stop);
            resolve(value);
          }),
        (error: unknown) =>
          finish(() => {
            this.#stopListeners.delete(stop);
            reject(error);
          }),
      );
    });
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const queue of this.#queues) queue.stop(this.error);
    this.#queues.clear();
    for (const stop of this.#stopListeners) stop();
    this.#stopListeners.clear();
  }
}

class InlineStream implements Stream {
  readonly #logId: EventLogId;
  readonly #scope: InlineRunScope;
  readonly #service: MemoryPrototypeService;

  constructor(service: MemoryPrototypeService, scope: InlineRunScope, logId: EventLogId) {
    this.#logId = logId;
    this.#scope = scope;
    this.#service = service;
  }

  async append(event: StreamEvent): Promise<void> {
    await this.#scope.run(async () => {
      await this.#service.append(this.#logId, event);
    });
  }
}

class InlineLoopBackend implements LoopBackend {
  readonly executionId: ExecutionId;
  readonly stream: Stream;
  readonly #deliveries: AsyncQueue<Delivery>;
  readonly #nextBackendRunId: () => string;
  readonly #scope: InlineRunScope;
  readonly #service: MemoryPrototypeService;
  readonly #sessionId: SessionId;
  readonly #turnProtocol: TurnCheckpointProtocol | null;
  #checkpoint: SessionCheckpoint | null;

  constructor(input: {
    readonly checkpoint?: SessionCheckpoint;
    readonly executionId: ExecutionId;
    readonly nextBackendRunId: () => string;
    readonly scope: InlineRunScope;
    readonly service: MemoryPrototypeService;
    readonly sessionId: SessionId;
    readonly stream: Stream;
    readonly turnProtocol?: TurnCheckpointProtocol;
  }) {
    this.#checkpoint = input.checkpoint ?? null;
    this.executionId = input.executionId;
    this.#deliveries = input.scope.queue();
    this.#nextBackendRunId = input.nextBackendRunId;
    this.#scope = input.scope;
    this.#service = input.service;
    this.#sessionId = input.sessionId;
    this.stream = input.stream;
    this.#turnProtocol = input.turnProtocol ?? null;
  }

  async checkpoint(state: SessionState): Promise<void> {
    this.#scope.assertRunning();
    if (this.#checkpoint === null) {
      this.#checkpoint = initialCheckpoint(this.executionId, state);
      return;
    }
    const next = checkpointOwnedState(this.#checkpoint, this.executionId, state);
    if (this.#turnProtocol !== null) await this.#turnProtocol.accept(next);
    this.#checkpoint = next;
  }

  async executeTool(request: ApprovalRequest | ToolRequest): Promise<RequestResult> {
    const call = createExecuteToolEffect(request);
    const result = await this.#effect(call);
    return readExecuteToolResult(call, result);
  }

  async finish(outcome: TerminalOutcome): Promise<void> {
    this.#scope.assertRunning();
    if (this.#checkpoint?.state.phase !== "terminal") {
      throw new Error("Inline session finished without a terminal checkpoint.");
    }
    this.#service.finish(this.#sessionId, outcome);
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
    const result = await this.#effect(call);
    return readGenerateResult(call, result);
  }

  async receive(): Promise<Delivery> {
    this.#scope.assertRunning();
    return await this.#deliveries.shift();
  }

  spawnChild(input: DelegatedSessionInput): ChildHandle {
    this.#scope.assertRunning();
    const id = requestChildId(this.executionId, input.requestId);
    const backendRunId = this.#nextBackendRunId();
    const childStream = new InlineStream(
      this.#service,
      this.#scope,
      eventLogId(`${input.sessionId}:events`),
    );
    const backend = new InlineLoopBackend({
      executionId: executionId(id),
      nextBackendRunId: this.#nextBackendRunId,
      scope: this.#scope,
      service: this.#service,
      sessionId: input.sessionId,
      stream: childStream,
    });
    const result = this.#scope
      .run(async () => await runSession(backend, sessionProgramInput(input)))
      .finally(() => backend.dispose());
    return {
      id,
      wait: async () => {
        try {
          return await result;
        } catch (error) {
          throw childError(backendRunId, error);
        }
      },
    };
  }

  spawnTurn(input: TurnProgramInput): TurnHandle {
    this.#scope.assertRunning();
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
    const backend = new InlineLoopBackend({
      checkpoint: delegated,
      executionId: childExecutionId,
      nextBackendRunId: this.#nextBackendRunId,
      scope: this.#scope,
      service: this.#service,
      sessionId: input.state.sessionId,
      stream: this.stream,
      turnProtocol: protocol,
    });
    const backendRunId = this.#nextBackendRunId();
    const result = this.#scope
      .run(async () => {
        const outcome = await runTurn(backend, input);
        await protocol.complete(outcome.state);
        return outcome;
      })
      .finally(() => backend.dispose());
    return {
      id,
      wait: async () => {
        try {
          return await result;
        } catch (error) {
          throw childError(backendRunId, error);
        }
      },
    };
  }

  deliver(delivery: Delivery): void {
    this.#scope.assertRunning();
    this.#deliveries.push(delivery);
  }

  dispose(): void {
    this.#scope.release(this.#deliveries);
  }

  async #effect(call: EffectCall): Promise<EffectResult> {
    return await this.#scope.run(async () => {
      try {
        return { kind: "succeeded", output: await this.#service.effect(call) };
      } catch (error) {
        if (error instanceof DeclaredEffectFailure) {
          return { error: effectFailure(error), kind: "exhausted" };
        }
        throw error;
      }
    });
  }
}

class InlinePrototypeRun implements PrototypeRun {
  readonly backendRunId: string;
  readonly result: Promise<TerminalOutcome>;
  readonly sessionId: SessionId;
  readonly #backend: InlineLoopBackend;
  readonly #eventLogId: EventLogId;
  readonly #scope: InlineRunScope;
  readonly #service: MemoryPrototypeService;
  #settled = false;
  #stopped = false;

  constructor(input: {
    readonly backend: InlineLoopBackend;
    readonly backendRunId: string;
    readonly eventLogId: EventLogId;
    readonly result: Promise<TerminalOutcome>;
    readonly scope: InlineRunScope;
    readonly service: MemoryPrototypeService;
    readonly sessionId: SessionId;
  }) {
    this.#backend = input.backend;
    this.backendRunId = input.backendRunId;
    this.#eventLogId = input.eventLogId;
    this.result = input.result.finally(() => {
      this.#settled = true;
      this.#backend.dispose();
    });
    this.#scope = input.scope;
    this.#service = input.service;
    this.sessionId = input.sessionId;
  }

  async deliver(delivery: Delivery): Promise<void> {
    if (this.#stopped) throw this.#scope.error;
    if (this.#settled) throw new Error(`Inline run "${this.backendRunId}" is terminal.`);
    this.#backend.deliver(delivery);
  }

  async events() {
    return await this.#service.read(this.#eventLogId);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#scope.stop();
    try {
      await this.result;
    } catch (error) {
      if (error !== this.#scope.error) throw error;
    }
  }
}

export class InlinePrototypeRuntime implements PrototypeRuntime {
  readonly kind = "inline";
  readonly #runs = new Set<InlinePrototypeRun>();
  readonly #service = new MemoryPrototypeService();
  #closed = false;
  #nextRunOrdinal = 0;

  async attemptCount(id: OperationId): Promise<number> {
    return this.#service.attemptCount(id);
  }

  async callback(id: SessionId): Promise<TerminalOutcome | null> {
    return this.#service.callback(id);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#runs].map(async (run) => await run.stop()));
    await this.#service.close();
  }

  async events(logId: EventLogId) {
    return await this.#service.read(logId);
  }

  async executionCount(id: OperationId): Promise<number> {
    return this.#service.executionCount(id);
  }

  async start(input: PrototypeStartInput): Promise<PrototypeRun> {
    if (this.#closed) throw new Error("Inline prototype runtime is closed.");

    const ordinal = this.#nextRunOrdinal++;
    const backendRunId = `inline:${String(ordinal)}`;
    const scope = new InlineRunScope();
    const logId = eventLogId(`${input.sessionId}:events`);
    const backend = new InlineLoopBackend({
      executionId: executionId(`${input.sessionId}:execution:${String(ordinal)}`),
      nextBackendRunId: () => `inline:${String(this.#nextRunOrdinal++)}`,
      scope,
      service: this.#service,
      sessionId: input.sessionId,
      stream: new InlineStream(this.#service, scope, logId),
    });
    const result = runSession(backend, sessionProgramInput(input));
    const run = new InlinePrototypeRun({
      backend,
      backendRunId,
      eventLogId: logId,
      result,
      scope,
      service: this.#service,
      sessionId: input.sessionId,
    });
    this.#runs.add(run);
    void result.then(
      () => this.#runs.delete(run),
      () => this.#runs.delete(run),
    );
    return run;
  }

  async visibleEffectCount(id: OperationId): Promise<number> {
    return this.#service.visibleEffectCount(id);
  }
}

export function createInlinePrototypeRuntime(): Promise<PrototypeRuntime> {
  return Promise.resolve(new InlinePrototypeRuntime());
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

function childError(backendRunId: string, error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(`Inline child run "${backendRunId}" failed: ${String(error)}`);
}
