import type { DeliverPayload } from "#channel/types.js";
import { TASK_NOTIFICATIONS_PAYLOAD_KEY } from "#execution/tasks/delivery.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";
import type { TaskNotification } from "#runtime/tasks/types.js";

const COALESCED_DELIVER_FIELDS = ["context", "inputResponses", "message", "outputSchema"] as const;

/** Coalesces channel payloads while preserving turn input and adapter-specific fields. */
export function coalesceDeliverPayloads(payloads: readonly DeliverPayload[]): DeliverPayload {
  if (payloads.length === 0) return {};
  if (payloads.length === 1) return payloads[0] ?? {};

  const merged: Record<string, unknown> = {};
  const taskNotifications: TaskNotification[] = [];
  let turnInput: StepInput = {};

  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    // Concat-merged rather than last-write-wins: two coalesced
    // notifications must not clobber each other. The reserved field is
    // deliberately undeclared on the public payload type — it rides the
    // index signature (`#execution/tasks/delivery.js`).
    const notifications = payload[TASK_NOTIFICATIONS_PAYLOAD_KEY];
    if (Array.isArray(notifications)) {
      taskNotifications.push(...(notifications as TaskNotification[]));
    }
    turnInput = coalesceTurnInputs(turnInput, payload);
  }

  for (const field of COALESCED_DELIVER_FIELDS) {
    delete merged[field];
  }
  if (taskNotifications.length > 0) {
    merged[TASK_NOTIFICATIONS_PAYLOAD_KEY] = taskNotifications;
  }

  return Object.assign(merged, turnInput);
}
