import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { DurableSession } from "#execution/durable-session-store.js";
import { routeTaskNotifications } from "#execution/tasks/routing.js";
import type { TaskRecord } from "#execution/tasks/store.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { InputRequest } from "#runtime/input/types.js";
import type { TaskNotification } from "#runtime/tasks/types.js";

const readTaskRecordMock = vi.fn();
const updateTaskMock = vi.fn();

vi.mock("#execution/tasks/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tasks/store.js")>()),
  readTaskRecord: (input: unknown) => readTaskRecordMock(input),
}));

vi.mock("#execution/tasks/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tasks/service.js")>()),
  updateTask: (handle: unknown, responses: unknown) => updateTaskMock(handle, responses),
}));

const emissionState: HarnessEmissionState = {
  sequence: 7,
  sessionStarted: true,
  stepIndex: 2,
  turnId: "turn_1",
};

const inputRequest: InputRequest = {
  action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "get_weather" },
  prompt: "Allow get_weather?",
  requestId: "req_1",
};

function createDurableSession(liveTasks: Record<string, string>): DurableSession {
  return {
    agent: { system: "" },
    continuationToken: "http:session",
    history: [],
    sessionId: "session_1",
    state: Object.keys(liveTasks).length > 0 ? { "eve.runtime.liveTasks": liveTasks } : undefined,
  };
}

function terminalNotification(taskId: string): TaskNotification {
  return {
    kind: "task.terminal",
    task: {
      createdAt: "2026-07-23T00:00:00.000Z",
      lastUpdatedAt: "2026-07-23T00:00:01.000Z",
      result: "done",
      status: "completed",
      taskId,
      ttlMs: null,
    },
  };
}

function inputRequiredNotification(taskId: string): TaskNotification {
  return {
    kind: "task.status",
    task: {
      createdAt: "2026-07-23T00:00:00.000Z",
      inputRequests: [inputRequest],
      lastUpdatedAt: "2026-07-23T00:00:01.000Z",
      status: "input_required",
      taskId,
      ttlMs: null,
    },
  };
}

function captureWritable(): { chunks: Uint8Array[]; writable: WritableStream<Uint8Array> } {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    }),
  };
}

function decodeEvents(chunks: readonly Uint8Array[]): { type: string; data?: unknown }[] {
  const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { type: string; data?: unknown });
}

beforeEach(() => {
  readTaskRecordMock.mockReset();
  updateTaskMock.mockReset();
});

describe("routeTaskNotifications", () => {
  it("keeps terminal notifications on the remainder", async () => {
    const { writable } = captureWritable();
    const notification = terminalNotification("task_a");

    const remainder = await routeTaskNotifications({
      durableSession: createDurableSession({ task_a: "run_a" }),
      emissionState,
      parentWritable: writable,
      payload: { taskNotifications: [notification] },
    });

    expect(remainder).toEqual({ taskNotifications: [notification] });
  });

  it("consumes input_required and re-emits input.requested without a turn", async () => {
    const { chunks, writable } = captureWritable();

    const remainder = await routeTaskNotifications({
      durableSession: createDurableSession({ task_a: "run_a" }),
      emissionState,
      parentWritable: writable,
      payload: { taskNotifications: [inputRequiredNotification("task_a")] },
    });

    expect(remainder).toBeUndefined();
    const events = decodeEvents(chunks);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      data: { requests: [inputRequest], sequence: 7, stepIndex: 2, turnId: "turn_1" },
      type: "input.requested",
    });
  });

  it("drops notifications for tasks not on the live index", async () => {
    const { chunks, writable } = captureWritable();

    const remainder = await routeTaskNotifications({
      durableSession: createDurableSession({}),
      emissionState,
      parentWritable: writable,
      payload: { taskNotifications: [terminalNotification("task_unknown")] },
    });

    expect(remainder).toBeUndefined();
    expect(chunks).toHaveLength(0);
  });

  it("rejects cross-principal authenticated deliveries", async () => {
    const { writable } = captureWritable();
    readTaskRecordMock.mockResolvedValue({
      createdBy: { authenticator: "test", principalId: "user_owner" },
      endpoints: [],
      sessionId: "session_1",
      task: terminalNotification("task_a").task,
      taskRunId: "run_a",
    } satisfies TaskRecord);

    const intruder: SessionAuthContext = {
      attributes: {},
      authenticator: "test",
      principalId: "user_intruder",
      principalType: "user",
    };

    const remainder = await routeTaskNotifications({
      auth: intruder,
      durableSession: createDurableSession({ task_a: "run_a" }),
      emissionState,
      parentWritable: writable,
      payload: { taskNotifications: [terminalNotification("task_a")] },
    });

    expect(remainder).toBeUndefined();
    expect(readTaskRecordMock).toHaveBeenCalledWith({ taskRunId: "run_a" });
  });

  it("passes same-principal authenticated deliveries", async () => {
    const { writable } = captureWritable();
    readTaskRecordMock.mockResolvedValue({
      createdBy: { authenticator: "test", principalId: "user_owner" },
      endpoints: [],
      sessionId: "session_1",
      task: terminalNotification("task_a").task,
      taskRunId: "run_a",
    } satisfies TaskRecord);

    const owner: SessionAuthContext = {
      attributes: {},
      authenticator: "test",
      principalId: "user_owner",
      principalType: "user",
    };

    const remainder = await routeTaskNotifications({
      auth: owner,
      durableSession: createDurableSession({ task_a: "run_a" }),
      emissionState,
      parentWritable: writable,
      payload: { taskNotifications: [terminalNotification("task_a")] },
    });

    expect(remainder?.taskNotifications).toHaveLength(1);
  });

  it("splits a coalesced task + public payload: task resolves, message remains", async () => {
    const { chunks, writable } = captureWritable();

    const remainder = await routeTaskNotifications({
      durableSession: createDurableSession({ task_a: "run_a" }),
      emissionState,
      parentWritable: writable,
      payload: {
        message: "unrelated public message",
        taskNotifications: [inputRequiredNotification("task_a")],
      },
    });

    expect(remainder).toEqual({ message: "unrelated public message" });
    expect(decodeEvents(chunks)).toHaveLength(1);
  });

  it("routes late responses to live input_required tasks and returns the rest", async () => {
    readTaskRecordMock.mockResolvedValue({
      endpoints: [],
      sessionId: "session_1",
      task: inputRequiredNotification("task_a").task,
      taskRunId: "run_a",
    } satisfies TaskRecord);
    updateTaskMock.mockResolvedValue(undefined);

    const { routeLateResponsesToLiveTasks } = await import("#execution/tasks/routing.js");
    const { remaining } = await routeLateResponsesToLiveTasks({
      inputResponses: [
        { optionId: "approve", requestId: "req_1" },
        { requestId: "req_other", text: "unrelated" },
      ],
      state: { "eve.runtime.liveTasks": { task_a: "run_a" } },
    });

    expect(updateTaskMock).toHaveBeenCalledWith({ taskId: "task_a", taskRunId: "run_a" }, [
      { optionId: "approve", requestId: "req_1" },
    ]);
    expect(remaining).toEqual([{ requestId: "req_other", text: "unrelated" }]);
  });

  it("falls back to the stale path when updateTask rejects", async () => {
    readTaskRecordMock.mockResolvedValue({
      endpoints: [],
      sessionId: "session_1",
      task: inputRequiredNotification("task_a").task,
      taskRunId: "run_a",
    } satisfies TaskRecord);
    updateTaskMock.mockRejectedValue(new Error("task settled"));

    const { routeLateResponsesToLiveTasks } = await import("#execution/tasks/routing.js");
    const { remaining } = await routeLateResponsesToLiveTasks({
      inputResponses: [{ optionId: "approve", requestId: "req_1" }],
      state: { "eve.runtime.liveTasks": { task_a: "run_a" } },
    });

    expect(remaining).toEqual([{ optionId: "approve", requestId: "req_1" }]);
  });

  it("leaves responses untouched when no live task awaits input", async () => {
    readTaskRecordMock.mockResolvedValue({
      endpoints: [],
      sessionId: "session_1",
      task: terminalNotification("task_a").task,
      taskRunId: "run_a",
    } satisfies TaskRecord);

    const { routeLateResponsesToLiveTasks } = await import("#execution/tasks/routing.js");
    const responses = [{ optionId: "approve", requestId: "req_1" }];
    const { remaining } = await routeLateResponsesToLiveTasks({
      inputResponses: responses,
      state: { "eve.runtime.liveTasks": { task_a: "run_a" } },
    });

    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(remaining).toEqual(responses);
  });

  it("consumes progress and created kinds silently", async () => {
    const { chunks, writable } = captureWritable();

    const remainder = await routeTaskNotifications({
      durableSession: createDurableSession({ task_a: "run_a" }),
      emissionState,
      parentWritable: writable,
      payload: {
        taskNotifications: [
          {
            kind: "task.progress",
            task: {
              createdAt: "2026-07-23T00:00:00.000Z",
              lastUpdatedAt: "2026-07-23T00:00:01.000Z",
              status: "working",
              statusMessage: "halfway",
              taskId: "task_a",
              ttlMs: null,
            },
          },
        ],
      },
    });

    expect(remainder).toBeUndefined();
    expect(chunks).toHaveLength(0);
  });
});
