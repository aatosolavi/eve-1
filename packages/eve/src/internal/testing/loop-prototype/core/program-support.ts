import { eventId } from "./ids.js";
import type { OperationId, TurnDependencies, WireValue } from "./types.js";

export async function writeEvent(
  dependencies: TurnDependencies,
  operation: OperationId,
  payload: WireValue,
  eventOrdinal = 0,
): Promise<void> {
  await dependencies.stream.write({
    id: eventId(operation, eventOrdinal),
    operationId: operation,
    payload,
  });
}
