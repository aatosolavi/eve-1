import type { PrototypeService } from "./service-contract.js";
import {
  type EffectLedger,
  EffectProtocolError,
  executeScriptedEffect,
} from "./service-effects.js";
import type {
  EffectCall,
  EventLogId,
  EventRecord,
  SessionId,
  StreamEvent,
  TerminalOutcome,
  WireValue,
} from "./types.js";

export class MemoryPrototypeService implements PrototypeService, EffectLedger {
  readonly #attempts = new Map<string, number>();
  readonly #callbacks = new Map<string, TerminalOutcome>();
  readonly #effectResults = new Map<string, string>();
  readonly #events = new Map<string, EventRecord>();
  readonly #executions = new Map<string, number>();
  readonly #visibleEffects = new Map<string, string>();

  async append(logId: EventLogId, event: StreamEvent): Promise<EventRecord> {
    return appendEvent(this.#events, logId, event);
  }

  attemptCount(operationId: string): number {
    return this.#attempts.get(operationId) ?? 0;
  }

  callback(sessionId: string): TerminalOutcome | null {
    return this.#callbacks.get(sessionId) ?? null;
  }

  commitResult(call: EffectCall, result: string): string {
    const committed = this.#effectResults.get(call.id);
    if (committed !== undefined) {
      if (committed !== result) {
        throw new EffectProtocolError(
          `Effect result "${call.id}" was retried with different bytes.`,
        );
      }
      return committed;
    }
    this.#effectResults.set(call.id, result);
    return result;
  }

  committedResult(call: EffectCall): string | null {
    return this.#effectResults.get(call.id) ?? null;
  }

  async close(): Promise<void> {}

  async effect(call: EffectCall): Promise<WireValue> {
    return await executeScriptedEffect(this, call);
  }

  executionCount(operationId: string): number {
    return this.#executions.get(operationId) ?? 0;
  }

  finish(sessionId: SessionId, outcome: TerminalOutcome): void {
    const existing = this.#callbacks.get(sessionId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(outcome)) {
      throw new EffectProtocolError(`Conflicting callback for session "${sessionId}".`);
    }
    this.#callbacks.set(sessionId, outcome);
  }

  recordAttempt(call: EffectCall): number {
    const count = (this.#attempts.get(call.id) ?? 0) + 1;
    this.#attempts.set(call.id, count);
    return count;
  }

  recordExecution(call: EffectCall): void {
    this.#executions.set(call.id, this.executionCount(call.id) + 1);
  }

  recordVisibleEffect(call: EffectCall): void {
    const value = JSON.stringify({ input: call.input, name: call.name });
    const existing = this.#visibleEffects.get(call.id);
    if (existing !== undefined && existing !== value) {
      throw new EffectProtocolError(`Conflicting visible effect for operation "${call.id}".`);
    }
    this.#visibleEffects.set(call.id, value);
  }

  async read(logId: EventLogId): Promise<readonly EventRecord[]> {
    return [...this.#events.values()]
      .filter((event) => event.logId === logId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  visibleEffectCount(operationId: string): number {
    return this.#visibleEffects.has(operationId) ? 1 : 0;
  }
}

function appendEvent(
  events: Map<string, EventRecord>,
  logId: EventLogId,
  event: StreamEvent,
): EventRecord {
  const existing = events.get(event.id);
  if (existing !== undefined) {
    if (
      existing.logId !== logId ||
      existing.operationId !== event.operationId ||
      JSON.stringify(existing.payload) !== JSON.stringify(event.payload)
    ) {
      throw new Error(`Event "${event.id}" was retried with different bytes.`);
    }
    return existing;
  }

  const sequence = [...events.values()].filter((current) => current.logId === logId).length;
  const record = { ...event, logId, sequence };
  events.set(event.id, record);
  return record;
}
