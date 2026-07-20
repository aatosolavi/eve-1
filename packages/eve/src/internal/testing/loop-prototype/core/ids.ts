import type { ChildId, EventId, EventLogId, ExecutionId, OperationId, SessionId } from "./types.js";

export function childId(parent: ExecutionId, ordinal: number, kind: "session" | "turn"): ChildId {
  return encodeId(parent, kind, ordinal) as ChildId;
}

export function childSessionId(parent: SessionId, requestId: string): SessionId {
  return encodeId(parent, "child", requestId) as SessionId;
}

export function requestChildId(parent: ExecutionId, requestId: string): ChildId {
  return encodeId(parent, "session", requestId) as ChildId;
}

export function eventId(operation: OperationId, ordinal: number): EventId {
  return encodeId(operation, "event", ordinal) as EventId;
}

export function eventLogId(value: string): EventLogId {
  return value as EventLogId;
}

export function executionId(value: string): ExecutionId {
  return value as ExecutionId;
}

export function operationId(
  sessionId: SessionId,
  turnOrdinal: number,
  purpose: string,
): OperationId {
  return encodeId(sessionId, "turn", turnOrdinal, purpose) as OperationId;
}

export function sessionId(value: string): SessionId {
  return value as SessionId;
}

function encodeId(...parts: readonly (number | string)[]): string {
  return parts
    .map(String)
    .map((part) => `${String(part.length)}:${part}`)
    .join("|");
}
