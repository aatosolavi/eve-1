import { z } from "#compiled/zod/index.js";

import { inputRequestSchema } from "#runtime/input/types.js";
import type { JsonObject } from "#shared/json.js";
import { jsonValueSchema } from "#shared/json-schemas.js";

/**
 * Lifecycle status of a task, in the MCP tasks extension's vocabulary.
 *
 * `completed`, `failed`, and `cancelled` are terminal and final: once a
 * task reaches one of them it never transitions again (`cancelled` is
 * sticky even if execution later runs to completion).
 */
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * Zod schema for a task status.
 */
export const taskStatusSchema = z.enum([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
]);

const taskBaseShape = {
  createdAt: z.string(),
  lastUpdatedAt: z.string(),
  pollIntervalMs: z.number().optional(),
  statusMessage: z.string().optional(),
  taskId: z.string(),
  ttlMs: z.number().nullable(),
};

/**
 * The base task record: an identifiable container for an asynchronous,
 * long-running unit of work.
 *
 * Shape mirrors the MCP tasks extension's `Task` object exactly:
 * `taskId` is minted and high-entropy (never a session id or token),
 * timestamps are ISO 8601, and `ttlMs: null` means unlimited retention.
 */
export type Task = z.infer<typeof taskSchema>;

/**
 * Zod schema for the base task record.
 */
export const taskSchema = z
  .object({
    ...taskBaseShape,
    status: taskStatusSchema,
  })
  .strict();

const workingTaskSchema = z
  .object({
    ...taskBaseShape,
    status: z.literal("working"),
  })
  .strict();

const inputRequiredTaskSchema = z
  .object({
    ...taskBaseShape,
    inputRequests: z.array(inputRequestSchema),
    status: z.literal("input_required"),
  })
  .strict();

const completedTaskSchema = z
  .object({
    ...taskBaseShape,
    result: jsonValueSchema,
    status: z.literal("completed"),
  })
  .strict();

const failedTaskSchema = z
  .object({
    ...taskBaseShape,
    error: z
      .object({
        data: jsonValueSchema.optional(),
        message: z.string(),
      })
      .strict(),
    status: z.literal("failed"),
  })
  .strict();

const cancelledTaskSchema = z
  .object({
    ...taskBaseShape,
    status: z.literal("cancelled"),
  })
  .strict();

/**
 * Status-detailed task record, discriminated on `status`.
 *
 * Mirrors the extension's `DetailedTask`: `input_required` carries its
 * live input requests inline, `completed` carries the JSON `result` a
 * sync invocation would have placed at the call position, and `failed`
 * carries a structured `error` (never a `result`). The record is the
 * single source of truth for status, pending input, and outcome — there
 * is no separate result-retrieval operation.
 */
export type DetailedTask = z.infer<typeof detailedTaskSchema>;

/**
 * Zod schema for a status-detailed task record.
 */
export const detailedTaskSchema = z.discriminatedUnion("status", [
  workingTaskSchema,
  inputRequiredTaskSchema,
  completedTaskSchema,
  failedTaskSchema,
  cancelledTaskSchema,
]);

/**
 * Event kinds a task notification can carry.
 *
 * - `task.created` — record created at background election.
 * - `task.progress` — `statusMessage` changed; status still `working`.
 * - `task.status` — non-terminal status transition.
 * - `task.terminal` — `completed` | `failed` | `cancelled`, outcome
 *   inline on the snapshot.
 */
export type TaskNotificationKind = z.infer<typeof taskNotificationKindSchema>;

/**
 * Zod schema for a task notification kind.
 */
export const taskNotificationKindSchema = z.enum([
  "task.created",
  "task.progress",
  "task.status",
  "task.terminal",
]);

/**
 * One task notification: an explicit event kind plus the full
 * `DetailedTask` snapshot.
 *
 * Mirrors `notifications/tasks` params, which carry the whole record
 * rather than a delta — consumers never reconstruct state from event
 * history.
 */
export type TaskNotification = z.infer<typeof taskNotificationSchema>;

/**
 * Zod schema for one task notification envelope.
 */
export const taskNotificationSchema = z
  .object({
    kind: taskNotificationKindSchema,
    task: detailedTaskSchema,
  })
  .strict();

/**
 * A stored notification endpoint: a POST target for task notifications,
 * as `/eve/v1/callback/:token` today — local and remote alike.
 *
 * Endpoint URLs are capabilities (the token is embedded in the URL):
 * they are stored, never emitted on streams or surfaced to the model.
 */
export interface NotificationEndpoint {
  readonly url: string;
}

/**
 * Notification kinds delivered to an endpoint that registered without a
 * per-endpoint filter.
 *
 * Deliberately narrow — wake-worthy only: the default registered
 * endpoint is the caller's session driver, and a delivery wakes it (and
 * may run a turn), so progress chatter must not route there. A passive
 * observer that wants the full feed overrides this on registration.
 */
export const DEFAULT_NOTIFICATION_ROUTES: readonly TaskNotificationKind[] = [
  "task.status",
  "task.terminal",
];

/**
 * Returns true when a status is terminal (`completed` | `failed` |
 * `cancelled`). Terminal states are final.
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Returns true when a value is shaped like the `CreateTaskResult`
 * placeholder — used to tell a background-election placeholder apart
 * from a real tool outcome (e.g. to suppress `subagent.completed` for
 * work that just started).
 */
export function isCreateTaskResultShaped(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.taskId === "string" &&
    taskStatusSchema.safeParse(candidate.status).success &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.lastUpdatedAt === "string" &&
    (candidate.ttlMs === null || typeof candidate.ttlMs === "number")
  );
}

/**
 * Projects a task into the flat `CreateTaskResult`-shaped placeholder
 * placed at the tool-call position on background election.
 *
 * The model sees this in place of the tool result; the real outcome
 * enters as new input when the task's terminal notification arrives.
 */
export function toCreateTaskResult(task: Task): JsonObject {
  const result: Record<string, JsonObject[string]> = {
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    status: task.status,
    taskId: task.taskId,
    ttlMs: task.ttlMs,
  };
  if (task.statusMessage !== undefined) {
    result.statusMessage = task.statusMessage;
  }
  if (task.pollIntervalMs !== undefined) {
    result.pollIntervalMs = task.pollIntervalMs;
  }
  return result;
}
