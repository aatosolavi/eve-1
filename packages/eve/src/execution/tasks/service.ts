/**
 * Task operations, mirroring the MCP tasks extension's semantics.
 *
 * Caller-facing operations (`getTask`, `updateTask`, `cancelTask`) and
 * executor-side transitions (`completeTask`, `failTask`,
 * `requireTaskInput`, `setTaskStatusMessage`) are all expressed against
 * the owning actor run: reads are cross-run tail reads, writes are
 * commands resumed onto the actor's hook and acknowledged via
 * `lastCommandId` on the next snapshot.
 */
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import { isTerminalStatus, type DetailedTask } from "#runtime/tasks/types.js";
import {
  taskCommandHookToken,
  type TaskCommand,
  type TaskCommandHookPayload,
} from "#execution/tasks/commands.js";
import {
  awaitTaskRecord,
  readTaskRecord,
  type StoredNotificationEndpoint,
  type TaskCreatedBy,
  type TaskRecord,
} from "#execution/tasks/store.js";
import { taskWorkflow } from "#execution/tasks/workflow.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import type { JsonValue } from "#shared/json.js";

const COMMAND_SEND_RETRY_DELAY_MS = 100;
const COMMAND_SEND_TIMEOUT_MS = 10_000;

/**
 * Addresses one task: the minted public id plus the owning actor run.
 * The run id is store-internal (kept on the live-task index and the
 * record itself); only `taskId` ever appears on streams.
 */
export interface TaskHandle {
  readonly taskId: string;
  readonly taskRunId: string;
}

/**
 * Mints a task id: high-entropy, never derived from a session id or
 * token.
 */
export function mintTaskId(): string {
  return `task_${crypto.randomUUID()}`;
}

/**
 * Creates a task: mints the id, starts the owning actor run, and waits
 * for the initial `working` snapshot so the record observably exists
 * before the caller projects the placeholder.
 */
export async function createTask(input: {
  readonly createdBy?: TaskCreatedBy | null;
  readonly endpoints: readonly StoredNotificationEndpoint[];
  readonly sessionId: string;
  readonly ttlMs: number | null;
}): Promise<TaskRecord> {
  const taskId = mintTaskId();
  const run = await start(taskWorkflow, [
    {
      createdBy: input.createdBy,
      endpoints: input.endpoints,
      sessionId: input.sessionId,
      taskId,
      ttlMs: input.ttlMs,
    },
  ]);
  return await awaitTaskRecord({ taskRunId: run.runId });
}

/**
 * Reads one task (`tasks/get` semantics).
 */
export async function getTask(handle: TaskHandle): Promise<DetailedTask> {
  const record = await readTaskRecord({ taskRunId: handle.taskRunId });
  return record.task;
}

/**
 * Routes input responses to an `input_required` task (`tasks/update`
 * semantics): records the responses and transitions back to `working`.
 * Throws when the task is not awaiting input.
 */
export async function updateTask(
  handle: TaskHandle,
  inputResponses: readonly InputResponse[],
): Promise<DetailedTask> {
  const current = await readTaskRecord({ taskRunId: handle.taskRunId });
  if (current.task.status !== "input_required") {
    throw new Error(
      `Cannot update task ${handle.taskId}: status is "${current.task.status}", not "input_required".`,
    );
  }
  const record = await sendTaskCommand(handle, {
    inputResponses: [...inputResponses],
    kind: "update",
  });
  return record.task;
}

/**
 * Cancels a task (`tasks/cancel` semantics): cooperative and sticky.
 * A task already terminal is returned unchanged — terminal states are
 * final.
 */
export async function cancelTask(handle: TaskHandle): Promise<DetailedTask> {
  const current = await readTaskRecord({ taskRunId: handle.taskRunId });
  if (isTerminalStatus(current.task.status)) {
    return current.task;
  }
  const record = await sendTaskCommand(handle, { kind: "cancel" });
  return record.task;
}

/**
 * Executor-side terminal success: `result` is the JSON output a sync
 * invocation would have placed at the call position.
 */
export async function completeTask(handle: TaskHandle, result: JsonValue): Promise<DetailedTask> {
  const record = await sendTaskCommand(handle, { kind: "complete", result });
  return record.task;
}

/**
 * Executor-side terminal failure.
 */
export async function failTask(
  handle: TaskHandle,
  error: { readonly data?: JsonValue; readonly message: string },
): Promise<DetailedTask> {
  const record = await sendTaskCommand(handle, { error, kind: "fail" });
  return record.task;
}

/**
 * Executor-side transition to `input_required` with the live requests
 * inline on the record.
 */
export async function requireTaskInput(
  handle: TaskHandle,
  inputRequests: readonly InputRequest[],
): Promise<DetailedTask> {
  const record = await sendTaskCommand(handle, {
    inputRequests: [...inputRequests],
    kind: "require-input",
  });
  return record.task;
}

/**
 * Executor-side progress: sets `statusMessage` (emits `task.progress`,
 * unrouted by default).
 */
export async function setTaskStatusMessage(
  handle: TaskHandle,
  statusMessage: string,
): Promise<DetailedTask> {
  const record = await sendTaskCommand(handle, { kind: "set-status-message", statusMessage });
  return record.task;
}

/**
 * Resumes one command onto the actor's hook and waits for the actor to
 * acknowledge it on a snapshot.
 *
 * `HookNotFoundError` is ambiguous — the hook may not exist *yet*
 * (create race) or not exist *anymore* (task settled, hook disposed).
 * The record disambiguates: terminal → settled, return as-is (the
 * command would be a legality no-op anyway); otherwise retry briefly.
 */
async function sendTaskCommand(handle: TaskHandle, command: TaskCommand): Promise<TaskRecord> {
  const commandId = crypto.randomUUID();
  const payload: TaskCommandHookPayload = { command, commandId, kind: "task-command" };
  const deadline = Date.now() + COMMAND_SEND_TIMEOUT_MS;

  for (;;) {
    try {
      await resumeHook(taskCommandHookToken(handle.taskId), payload);
      break;
    } catch (error) {
      if (!HookNotFoundError.is(error)) {
        throw error;
      }
      const record = await readTaskRecord({ taskRunId: handle.taskRunId });
      if (isTerminalStatus(record.task.status)) {
        return record;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out sending command to task ${handle.taskId}: command hook never became available.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, COMMAND_SEND_RETRY_DELAY_MS));
    }
  }

  try {
    return await awaitTaskRecord({
      predicate: (record) => record.lastCommandId === commandId,
      taskRunId: handle.taskRunId,
    });
  } catch (error) {
    // A command that raced the actor's terminal exit is never applied;
    // the settled record is the authoritative answer.
    const record = await readTaskRecord({ taskRunId: handle.taskRunId });
    if (isTerminalStatus(record.task.status)) {
      return record;
    }
    throw error;
  }
}
