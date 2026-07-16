import { eventId } from "./ids.js";
import type { LoopBackend, OperationId, WireValue } from "./types.js";

export async function appendEvent(
  backend: LoopBackend,
  operation: OperationId,
  payload: WireValue,
  eventOrdinal = 0,
): Promise<void> {
  await backend.stream.append({
    id: eventId(operation, eventOrdinal),
    operationId: operation,
    payload,
  });
}
