/**
 * The task actor: one durable workflow run per background task.
 *
 * The actor owns the task record single-writer. It writes the initial
 * `working` snapshot, then loops on its command hook
 * (`taskCommandHookToken(taskId)`): each resumed command is validated
 * and applied under the transition legality rules
 * (`#execution/tasks/commands.js`), the new snapshot is appended to the
 * actor's own `eve.task` stream, and the transition's notification is
 * fanned out to the registered endpoints. The run returns when the
 * record reaches a terminal status — terminal states are final by
 * construction, and a command resumed after the hook is disposed
 * surfaces `HookNotFoundError` to the sender (the task is settled).
 *
 * Readers never talk to the actor: they tail-read its stream cross-run
 * (`#execution/tasks/store.js`).
 */
import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import { taskCommandHookToken } from "#execution/tasks/commands.js";
import { disposeHook } from "#execution/hook-ownership.js";
import type { TaskCreatedBy, StoredNotificationEndpoint } from "#execution/tasks/store.js";
import { applyTaskCommandStep, initializeTaskStep } from "#execution/tasks/workflow-steps.js";
import { isTerminalStatus, type DetailedTask } from "#runtime/tasks/types.js";

/**
 * Start input of one task actor run.
 */
export interface TaskWorkflowInput {
  readonly createdBy?: TaskCreatedBy | null;
  readonly endpoints: readonly StoredNotificationEndpoint[];
  readonly sessionId: string;
  readonly taskId: string;
  readonly ttlMs: number | null;
}

/**
 * Runs one background task's record to a terminal status.
 */
export async function taskWorkflow(input: TaskWorkflowInput): Promise<DetailedTask> {
  "use workflow";

  const { workflowRunId: taskRunId } = getWorkflowMetadata();
  const hook = createHook<unknown>({ token: taskCommandHookToken(input.taskId) });
  const iterator = hook[Symbol.asyncIterator]();

  try {
    let record = await initializeTaskStep({
      createdBy: input.createdBy,
      endpoints: input.endpoints,
      sessionId: input.sessionId,
      taskId: input.taskId,
      taskRunId,
      ttlMs: input.ttlMs,
    });

    while (!isTerminalStatus(record.task.status)) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      record = await applyTaskCommandStep({ payload: next.value, record });
    }

    return record.task;
  } finally {
    await disposeHook(hook);
  }
}
