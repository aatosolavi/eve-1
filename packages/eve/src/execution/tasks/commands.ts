/**
 * Task transition commands and the pure transition function.
 *
 * Every write to a task record is a command resumed onto the owning
 * actor's hook (`#execution/tasks/workflow.js`); the actor applies
 * {@link applyTaskTransition} single-writer, so legality — terminal
 * states are final, `cancelled` is sticky, `update` requires
 * `input_required` — is enforced in exactly one place and transition
 * bursts are ordered.
 */
import { z } from "#compiled/zod/index.js";

import { inputRequestSchema, inputResponseSchema } from "#runtime/input/types.js";
import {
  isTerminalStatus,
  type DetailedTask,
  type TaskNotificationKind,
} from "#runtime/tasks/types.js";
import type { TaskRecord } from "#execution/tasks/store.js";
import { jsonValueSchema } from "#shared/json-schemas.js";
import type { JsonValue } from "#shared/json.js";

/**
 * One transition command addressed to a task actor.
 */
export type TaskCommand = z.infer<typeof taskCommandSchema>;

const taskErrorSchema = z
  .object({
    data: jsonValueSchema.optional(),
    message: z.string(),
  })
  .strict();

/**
 * Zod schema for one task transition command.
 */
export const taskCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cancel") }).strict(),
  z.object({ kind: z.literal("complete"), result: jsonValueSchema }).strict(),
  z.object({ error: taskErrorSchema, kind: z.literal("fail") }).strict(),
  z
    .object({ inputRequests: z.array(inputRequestSchema), kind: z.literal("require-input") })
    .strict(),
  z.object({ kind: z.literal("set-status-message"), statusMessage: z.string() }).strict(),
  z.object({ inputResponses: z.array(inputResponseSchema), kind: z.literal("update") }).strict(),
]);

/**
 * The hook payload a task actor consumes. `commandId` is echoed back on
 * the written snapshot (`TaskRecord.lastCommandId`) so senders can poll
 * for their command's application.
 */
export type TaskCommandHookPayload = z.infer<typeof taskCommandHookPayloadSchema>;

/**
 * Zod schema for one task-command hook payload. The actor validates
 * every resumed payload and ignores anything malformed.
 */
export const taskCommandHookPayloadSchema = z
  .object({
    command: taskCommandSchema,
    commandId: z.string(),
    kind: z.literal("task-command"),
  })
  .strict();

/**
 * Token of a task actor's command hook.
 */
export function taskCommandHookToken(taskId: string): string {
  return `${taskId}:commands`;
}

/**
 * Result of applying one command: the next record snapshot, plus the
 * notification kind to fan out (absent for no-op commands).
 */
export interface TaskTransitionResult {
  readonly notificationKind?: TaskNotificationKind;
  readonly record: TaskRecord;
}

/**
 * Applies one command to a record. Pure — timestamps are inputs.
 *
 * Illegal commands (any command on a terminal task, `update` outside
 * `input_required`, `set-status-message` outside `working`) are no-ops
 * that still acknowledge the command id, so senders always observe
 * their command settled and read the unchanged record.
 */
export function applyTaskTransition(input: {
  readonly command: TaskCommand;
  readonly commandId: string;
  readonly now: string;
  readonly record: TaskRecord;
}): TaskTransitionResult {
  const { command, commandId, now, record } = input;
  const acknowledge = (next?: {
    readonly inputResponses?: readonly z.infer<typeof inputResponseSchema>[];
    readonly notificationKind?: TaskNotificationKind;
    readonly task?: DetailedTask;
  }): TaskTransitionResult => {
    const nextRecord: TaskRecord = {
      ...record,
      lastCommandId: commandId,
      task: next?.task ?? record.task,
    };
    const result: { notificationKind?: TaskNotificationKind; record: TaskRecord } = {
      record:
        next?.inputResponses === undefined
          ? nextRecord
          : { ...nextRecord, inputResponses: next.inputResponses },
    };
    if (next?.notificationKind !== undefined) {
      result.notificationKind = next.notificationKind;
    }
    return result;
  };

  if (isTerminalStatus(record.task.status)) {
    return acknowledge();
  }

  const base = baseTask(record.task, now);

  switch (command.kind) {
    case "cancel":
      return acknowledge({
        notificationKind: "task.terminal",
        task: { ...base, status: "cancelled" },
      });
    case "complete":
      return acknowledge({
        notificationKind: "task.terminal",
        task: { ...base, result: command.result, status: "completed" },
      });
    case "fail":
      return acknowledge({
        notificationKind: "task.terminal",
        task: { ...base, error: command.error, status: "failed" },
      });
    case "require-input":
      return acknowledge({
        notificationKind: "task.status",
        task: { ...base, inputRequests: command.inputRequests, status: "input_required" },
      });
    case "set-status-message":
      if (record.task.status !== "working") {
        return acknowledge();
      }
      return acknowledge({
        notificationKind: "task.progress",
        task: { ...base, status: "working", statusMessage: command.statusMessage },
      });
    case "update":
      if (record.task.status !== "input_required") {
        return acknowledge();
      }
      return acknowledge({
        inputResponses: [...(record.inputResponses ?? []), ...command.inputResponses],
        notificationKind: "task.status",
        task: { ...base, status: "working" },
      });
  }
}

/**
 * Projects an error-shaped tool output into the task `error` payload:
 * `message` from the output when it is a string, the original output
 * preserved under `data` otherwise.
 */
export function taskErrorFromToolOutput(output: JsonValue): { data?: JsonValue; message: string } {
  if (typeof output === "string") {
    return { message: output };
  }
  return { data: output, message: "Tool execution failed." };
}

function baseTask(
  task: DetailedTask,
  now: string,
): Omit<DetailedTask, "status" | "result" | "error" | "inputRequests"> {
  const base: {
    createdAt: string;
    lastUpdatedAt: string;
    pollIntervalMs?: number;
    statusMessage?: string;
    taskId: string;
    ttlMs: number | null;
  } = {
    createdAt: task.createdAt,
    lastUpdatedAt: now,
    taskId: task.taskId,
    ttlMs: task.ttlMs,
  };
  if (task.statusMessage !== undefined) {
    base.statusMessage = task.statusMessage;
  }
  if (task.pollIntervalMs !== undefined) {
    base.pollIntervalMs = task.pollIntervalMs;
  }
  return base;
}
