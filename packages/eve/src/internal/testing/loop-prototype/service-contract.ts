import type {
  EffectCall,
  PrototypeEventStore,
  SessionId,
  TerminalOutcome,
  WireValue,
} from "./types.js";

export interface PrototypeService extends PrototypeEventStore {
  attemptCount(operationId: string): number;
  callback(sessionId: string): TerminalOutcome | null;
  close(): Promise<void>;
  effect(call: EffectCall): Promise<WireValue>;
  executionCount(operationId: string): number;
  finish(sessionId: SessionId, outcome: TerminalOutcome): void;
  visibleEffectCount(operationId: string): number;
}
