import { describe, expect, it } from "vitest";

import {
  applyTaskTransition,
  taskCommandHookPayloadSchema,
  taskErrorFromToolOutput,
} from "#execution/tasks/commands.js";
import type { TaskRecord } from "#execution/tasks/store.js";
import type { InputRequest } from "#runtime/input/types.js";
import type { DetailedTask } from "#runtime/tasks/types.js";

const NOW = "2026-07-23T01:00:00.000Z";

const inputRequest: InputRequest = {
  action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "get_weather" },
  prompt: "Allow?",
  requestId: "req_1",
};

function createRecord(task?: Partial<DetailedTask>): TaskRecord {
  return {
    endpoints: [{ url: "https://caller.example/eve/v1/callback/tok" }],
    sessionId: "session_1",
    task: {
      createdAt: "2026-07-23T00:00:00.000Z",
      lastUpdatedAt: "2026-07-23T00:00:00.000Z",
      status: "working",
      taskId: "task_1",
      ttlMs: null,
      ...task,
    } as DetailedTask,
    taskRunId: "run_1",
  };
}

function apply(record: TaskRecord, command: Parameters<typeof applyTaskTransition>[0]["command"]) {
  return applyTaskTransition({ command, commandId: "cmd_1", now: NOW, record });
}

describe("applyTaskTransition", () => {
  it("completes a working task with the result inline", () => {
    const applied = apply(createRecord(), { kind: "complete", result: { ok: true } });

    expect(applied.notificationKind).toBe("task.terminal");
    expect(applied.record.task).toMatchObject({
      lastUpdatedAt: NOW,
      result: { ok: true },
      status: "completed",
    });
    expect(applied.record.lastCommandId).toBe("cmd_1");
  });

  it("fails a working task with a structured error and no result", () => {
    const applied = apply(createRecord(), {
      error: { data: { code: 500 }, message: "boom" },
      kind: "fail",
    });

    expect(applied.notificationKind).toBe("task.terminal");
    expect(applied.record.task).toMatchObject({ error: { message: "boom" }, status: "failed" });
    expect("result" in applied.record.task).toBe(false);
  });

  it("cancels a working task", () => {
    const applied = apply(createRecord(), { kind: "cancel" });
    expect(applied.notificationKind).toBe("task.terminal");
    expect(applied.record.task.status).toBe("cancelled");
  });

  it("transitions working → input_required carrying the live requests", () => {
    const applied = apply(createRecord(), {
      inputRequests: [inputRequest],
      kind: "require-input",
    });

    expect(applied.notificationKind).toBe("task.status");
    expect(applied.record.task).toMatchObject({
      inputRequests: [inputRequest],
      status: "input_required",
    });
  });

  it("routes update responses and returns to working", () => {
    const awaiting = apply(createRecord(), {
      inputRequests: [inputRequest],
      kind: "require-input",
    }).record;

    const applied = applyTaskTransition({
      command: { inputResponses: [{ optionId: "approve", requestId: "req_1" }], kind: "update" },
      commandId: "cmd_2",
      now: NOW,
      record: awaiting,
    });

    expect(applied.notificationKind).toBe("task.status");
    expect(applied.record.task.status).toBe("working");
    expect("inputRequests" in applied.record.task).toBe(false);
    expect(applied.record.inputResponses).toEqual([{ optionId: "approve", requestId: "req_1" }]);
  });

  it("no-ops update outside input_required but still acknowledges", () => {
    const applied = apply(createRecord(), {
      inputResponses: [{ requestId: "req_1", text: "yes" }],
      kind: "update",
    });

    expect(applied.notificationKind).toBeUndefined();
    expect(applied.record.task.status).toBe("working");
    expect(applied.record.inputResponses).toBeUndefined();
    expect(applied.record.lastCommandId).toBe("cmd_1");
  });

  it("emits task.progress for a status message on a working task only", () => {
    const progressed = apply(createRecord(), {
      kind: "set-status-message",
      statusMessage: "halfway",
    });
    expect(progressed.notificationKind).toBe("task.progress");
    expect(progressed.record.task.statusMessage).toBe("halfway");

    const awaiting = apply(createRecord(), {
      inputRequests: [inputRequest],
      kind: "require-input",
    }).record;
    const ignored = applyTaskTransition({
      command: { kind: "set-status-message", statusMessage: "late" },
      commandId: "cmd_3",
      now: NOW,
      record: awaiting,
    });
    expect(ignored.notificationKind).toBeUndefined();
    expect(ignored.record.task.status).toBe("input_required");
  });

  it("keeps terminal states final — cancelled is sticky under a later complete", () => {
    const cancelled = apply(createRecord(), { kind: "cancel" }).record;
    const applied = applyTaskTransition({
      command: { kind: "complete", result: "too late" },
      commandId: "cmd_4",
      now: NOW,
      record: cancelled,
    });

    expect(applied.notificationKind).toBeUndefined();
    expect(applied.record.task.status).toBe("cancelled");
    expect(applied.record.lastCommandId).toBe("cmd_4");
  });
});

describe("taskCommandHookPayloadSchema", () => {
  it("accepts a well-formed payload and rejects malformed ones", () => {
    expect(
      taskCommandHookPayloadSchema.safeParse({
        command: { kind: "cancel" },
        commandId: "cmd_1",
        kind: "task-command",
      }).success,
    ).toBe(true);
    expect(
      taskCommandHookPayloadSchema.safeParse({ command: { kind: "explode" }, kind: "task-command" })
        .success,
    ).toBe(false);
  });
});

describe("taskErrorFromToolOutput", () => {
  it("uses a string output as the message", () => {
    expect(taskErrorFromToolOutput("it broke")).toEqual({ message: "it broke" });
  });

  it("preserves structured output under data", () => {
    expect(taskErrorFromToolOutput({ reason: "quota" })).toEqual({
      data: { reason: "quota" },
      message: "Tool execution failed.",
    });
  });
});
