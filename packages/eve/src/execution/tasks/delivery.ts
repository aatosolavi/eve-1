/**
 * Task-notification deliver-payload helpers.
 *
 * A task notification enters a session as an ordinary `deliver` hook
 * payload carrying the reserved `taskNotifications` field — the
 * driver's wake vocabulary stays `deliver`-only and discrimination
 * happens in step bodies. The field is framework-owned: it is stripped
 * from inbound public deliveries at the runtime ingress and from
 * adapter-visible payloads in the turn step, so only the callback
 * route (a capability URL) and framework code can inject it.
 *
 * This module is pure and driver-body-safe: no logging, no node
 * built-ins (`route-child-delivery.js` is compiled into the pinned
 * driver bundle).
 */
import type { DeliverPayload } from "#channel/types.js";
import {
  taskNotificationSchema,
  type DetailedTask,
  type TaskNotification,
} from "#runtime/tasks/types.js";
import type { JsonObject } from "#shared/json.js";

/** Reserved deliver-payload field carrying task notifications. */
export const TASK_NOTIFICATIONS_PAYLOAD_KEY = "taskNotifications";

/**
 * Returns true when a payload carries at least one task notification.
 * Structural check only — validation happens at read.
 */
export function payloadCarriesTaskNotifications(payload: DeliverPayload): boolean {
  const raw = payload[TASK_NOTIFICATIONS_PAYLOAD_KEY];
  return Array.isArray(raw) && raw.length > 0;
}

/**
 * Reads and validates the task notifications on a payload. Malformed
 * entries are dropped — the wire crosses deployments and versions.
 */
export function readTaskNotifications(payload: DeliverPayload): readonly TaskNotification[] {
  const raw = payload[TASK_NOTIFICATIONS_PAYLOAD_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  const notifications: TaskNotification[] = [];
  for (const entry of raw) {
    const parsed = taskNotificationSchema.safeParse(entry);
    if (parsed.success) {
      notifications.push(parsed.data);
    }
  }
  return notifications;
}

/**
 * Splits the reserved field off a payload. `rest` is `undefined` when
 * nothing else remains on the payload — the caller then has no
 * parent-local remainder to run a turn with.
 */
export function splitTaskNotifications(payload: DeliverPayload): {
  readonly notifications: readonly TaskNotification[];
  readonly rest: DeliverPayload | undefined;
} {
  if (!(TASK_NOTIFICATIONS_PAYLOAD_KEY in payload)) {
    return { notifications: [], rest: payload };
  }
  const { [TASK_NOTIFICATIONS_PAYLOAD_KEY]: _stripped, ...rest } = payload;
  return {
    notifications: readTaskNotifications(payload),
    rest: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

/**
 * Strips the reserved field from an inbound public delivery so a
 * channel caller can never forge a task notification (half of the
 * initiator-binding invariant; the other half is principal comparison
 * at routing).
 */
export function sanitizeInboundDeliverPayload(payload: DeliverPayload): DeliverPayload {
  if (!(TASK_NOTIFICATIONS_PAYLOAD_KEY in payload)) {
    return payload;
  }
  const { [TASK_NOTIFICATIONS_PAYLOAD_KEY]: _stripped, ...rest } = payload;
  return rest;
}

/**
 * Projects a terminal task into the system-authored turn input the
 * model sees. The outcome enters as new input — the original call
 * position was terminalized with the placeholder at election.
 */
export function formatTaskOutcomeMessage(task: DetailedTask): string {
  const outcome: Record<string, JsonObject[string]> = {
    status: task.status,
    taskId: task.taskId,
  };
  if (task.status === "completed") {
    outcome.result = task.result;
  }
  if (task.status === "failed") {
    outcome.error = task.error;
  }
  if (task.statusMessage !== undefined) {
    outcome.statusMessage = task.statusMessage;
  }
  return `Background task ${task.taskId} is now ${task.status}.\n${JSON.stringify(outcome)}`;
}
