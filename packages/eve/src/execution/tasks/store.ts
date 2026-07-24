/**
 * Read side of the task-record store.
 *
 * Each background task is owned by a dedicated `taskWorkflow` actor run
 * (`#execution/tasks/workflow.js`): the actor is the record's single
 * writer and appends one full snapshot to its own `eve.task` stream per
 * applied transition. Workflow-run streams are write-local but
 * read-global, so any step — the routing step, the turn step, tests —
 * reads the current record with a cross-run tail read; all writes go
 * through the actor's command hook instead
 * (`#execution/tasks/service.js`).
 */
import { z } from "#compiled/zod/index.js";

import { inputResponseSchema, type InputResponse } from "#runtime/input/types.js";
import {
  detailedTaskSchema,
  taskNotificationKindSchema,
  type DetailedTask,
  type TaskNotificationKind,
} from "#runtime/tasks/types.js";
import { getRun } from "#internal/workflow/runtime.js";

/** Stream namespace the task actor writes record snapshots to. */
export const TASK_STREAM_NAMESPACE = "eve.task";

const TASK_RECORD_READ_TIMEOUT_MS = 10_000;
const TASK_RECORD_POLL_INTERVAL_MS = 50;

/**
 * A stored notification endpoint.
 *
 * Extends the public contract with store-internal delivery state:
 * `dead` marks a gone subscriber (never retried), `routes` is the
 * per-endpoint kind filter (absent = `DEFAULT_NOTIFICATION_ROUTES`).
 * Endpoints are capabilities and never leave the store.
 */
export interface StoredNotificationEndpoint {
  readonly dead?: boolean;
  readonly routes?: readonly TaskNotificationKind[];
  readonly url: string;
}

/**
 * Zod schema for one stored notification endpoint.
 */
export const storedNotificationEndpointSchema: z.ZodType<StoredNotificationEndpoint> = z
  .object({
    dead: z.boolean().optional(),
    routes: z.array(taskNotificationKindSchema).optional(),
    url: z.string(),
  })
  .strict();

/**
 * Principal binding recorded at task creation (invariant: tasks are
 * bound to the auth context that created them).
 */
export interface TaskCreatedBy {
  readonly authenticator: string;
  readonly principalId: string;
}

const taskCreatedBySchema: z.ZodType<TaskCreatedBy> = z
  .object({
    authenticator: z.string(),
    principalId: z.string(),
  })
  .strict();

/**
 * One full task-record snapshot as written by the actor.
 *
 * `task` is the public `DetailedTask`; everything else is store-internal
 * (endpoints, principal binding, recorded input responses, and the id
 * of the last applied command — the acknowledgment senders poll for).
 */
export interface TaskRecord {
  readonly createdBy?: TaskCreatedBy | null;
  readonly endpoints: readonly StoredNotificationEndpoint[];
  readonly inputResponses?: readonly InputResponse[];
  readonly lastCommandId?: string;
  readonly sessionId: string;
  readonly task: DetailedTask;
  readonly taskRunId: string;
}

/**
 * Zod schema for one task-record snapshot.
 */
export const taskRecordSchema: z.ZodType<TaskRecord> = z
  .object({
    createdBy: taskCreatedBySchema.nullable().optional(),
    endpoints: z.array(storedNotificationEndpointSchema),
    inputResponses: z.array(inputResponseSchema).optional(),
    lastCommandId: z.string().optional(),
    sessionId: z.string(),
    task: detailedTaskSchema,
    taskRunId: z.string(),
  })
  .strict();

/**
 * Reads the latest task-record snapshot from the actor run's stream.
 *
 * Blocks until the first snapshot exists (the create race), up to
 * `timeoutMs`. Works from any step and from tests — the read is
 * cross-run.
 */
export async function readTaskRecord(input: {
  readonly taskRunId: string;
  readonly timeoutMs?: number;
}): Promise<TaskRecord> {
  const timeoutMs = input.timeoutMs ?? TASK_RECORD_READ_TIMEOUT_MS;
  const stream = getRun<unknown>(input.taskRunId).getReadable<unknown>({
    namespace: TASK_STREAM_NAMESPACE,
    startIndex: -1,
  });
  const reader = stream.getReader();
  let cancelReason = "eve task record tail read failed";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read().then((read) => ({ kind: "read" as const, read })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);

    if (result.kind === "timeout") {
      cancelReason = `eve task record tail read timed out after ${timeoutMs}ms`;
      throw new Error(
        `Timed out reading task record from run ${input.taskRunId} after ${timeoutMs}ms.`,
      );
    }

    if (result.read.done || result.read.value === undefined) {
      cancelReason = "eve task record tail read returned no snapshot";
      throw new Error(`No task record snapshot found for run ${input.taskRunId}.`);
    }

    cancelReason = "eve task record tail read complete";
    return taskRecordSchema.parse(result.read.value);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await reader.cancel(cancelReason).catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Polls the actor's stream until a snapshot satisfies `predicate`.
 *
 * Used by command senders to observe their own command applied
 * (`lastCommandId` acknowledgment) — the actor is the single writer, so
 * a satisfying snapshot is authoritative.
 */
export async function awaitTaskRecord(input: {
  readonly predicate?: (record: TaskRecord) => boolean;
  readonly taskRunId: string;
  readonly timeoutMs?: number;
}): Promise<TaskRecord> {
  const timeoutMs = input.timeoutMs ?? TASK_RECORD_READ_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `Timed out awaiting task record for run ${input.taskRunId} after ${timeoutMs}ms.`,
      );
    }

    const record = await readTaskRecord({ taskRunId: input.taskRunId, timeoutMs: remaining });
    if (input.predicate === undefined || input.predicate(record)) {
      return record;
    }

    await new Promise((resolve) => setTimeout(resolve, TASK_RECORD_POLL_INTERVAL_MS));
  }
}

/**
 * Public projection of a record read: the `DetailedTask` alone.
 */
export async function readDetailedTask(input: {
  readonly taskRunId: string;
  readonly timeoutMs?: number;
}): Promise<DetailedTask> {
  const record = await readTaskRecord(input);
  return record.task;
}
