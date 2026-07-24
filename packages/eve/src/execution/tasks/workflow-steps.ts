/**
 * Steps of the task actor (`#execution/tasks/workflow.js`).
 *
 * Both steps run inside the actor run, so `getWritable` targets the
 * actor's own `eve.task` stream — the single place record snapshots
 * are written.
 */
import { getWritable } from "#compiled/@workflow/core/index.js";

import { createLogger } from "#internal/logging.js";
import { applyTaskTransition, taskCommandHookPayloadSchema } from "#execution/tasks/commands.js";
import { TASK_STREAM_NAMESPACE, type TaskRecord } from "#execution/tasks/store.js";
import { notifyTaskEndpoints } from "#execution/tasks/notify.js";
import type { TaskCreatedBy, StoredNotificationEndpoint } from "#execution/tasks/store.js";

const log = createLogger("execution.task-workflow");

/**
 * Writes the initial `working` snapshot and emits `task.created`.
 *
 * The first snapshot is written before any notification is attempted so
 * `createTask` can observe the record as soon as the actor starts.
 */
export async function initializeTaskStep(input: {
  readonly createdBy?: TaskCreatedBy | null;
  readonly endpoints: readonly StoredNotificationEndpoint[];
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskRunId: string;
  readonly ttlMs: number | null;
}): Promise<TaskRecord> {
  "use step";

  const now = new Date().toISOString();
  const base: TaskRecord = {
    endpoints: input.endpoints,
    sessionId: input.sessionId,
    task: {
      createdAt: now,
      lastUpdatedAt: now,
      status: "working",
      taskId: input.taskId,
      ttlMs: input.ttlMs,
    },
    taskRunId: input.taskRunId,
  };
  const record: TaskRecord =
    input.createdBy === undefined ? base : { ...base, createdBy: input.createdBy };

  await writeTaskSnapshot(record);

  const endpoints = await notifyTaskEndpoints({
    endpoints: record.endpoints,
    notification: { kind: "task.created", task: record.task },
  });

  return await persistEndpointUpdates(record, endpoints);
}

/**
 * Validates and applies one command hook payload, persists the next
 * snapshot, and fans out the transition's notification.
 *
 * Malformed payloads are logged and ignored — a bad sender must not
 * fail the actor run.
 */
export async function applyTaskCommandStep(input: {
  readonly payload: unknown;
  readonly record: TaskRecord;
}): Promise<TaskRecord> {
  "use step";

  const parsed = taskCommandHookPayloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    log.warn("ignoring malformed task command payload", {
      taskId: input.record.task.taskId,
    });
    return input.record;
  }

  const applied = applyTaskTransition({
    command: parsed.data.command,
    commandId: parsed.data.commandId,
    now: new Date().toISOString(),
    record: input.record,
  });

  await writeTaskSnapshot(applied.record);

  if (applied.notificationKind === undefined) {
    return applied.record;
  }

  const endpoints = await notifyTaskEndpoints({
    endpoints: applied.record.endpoints,
    notification: { kind: applied.notificationKind, task: applied.record.task },
  });

  return await persistEndpointUpdates(applied.record, endpoints);
}

async function persistEndpointUpdates(
  record: TaskRecord,
  endpoints: readonly StoredNotificationEndpoint[],
): Promise<TaskRecord> {
  if (endpoints === record.endpoints) {
    return record;
  }
  const changed = endpoints.some((endpoint, index) => endpoint !== record.endpoints[index]);
  if (!changed) {
    return record;
  }
  const next: TaskRecord = { ...record, endpoints };
  await writeTaskSnapshot(next);
  return next;
}

async function writeTaskSnapshot(record: TaskRecord): Promise<void> {
  const writer = getWritable<TaskRecord>({ namespace: TASK_STREAM_NAMESPACE }).getWriter();
  try {
    await writer.write(record);
  } finally {
    writer.releaseLock();
  }
}
