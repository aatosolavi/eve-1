import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  cancelTask,
  completeTask,
  createTask,
  getTask,
  requireTaskInput,
  setTaskStatusMessage,
  updateTask,
  type TaskHandle,
} from "#execution/tasks/service.js";
import { readTaskRecord } from "#execution/tasks/store.js";
import type { InputRequest } from "#runtime/input/types.js";
import type { TaskNotification } from "#runtime/tasks/types.js";
import { getRun } from "#internal/workflow/runtime.js";

const inputRequest: InputRequest = {
  action: { callId: "call_1", input: {}, kind: "tool-call", toolName: "get_weather" },
  prompt: "Allow get_weather?",
  requestId: "req_1",
};

interface CapturedPost {
  readonly notification: TaskNotification;
  readonly url: string;
}

function stubNotificationSink(statusFor: (url: string) => number): CapturedPost[] {
  const posts: CapturedPost[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({
        notification: JSON.parse(String(init?.body)) as TaskNotification,
        url: String(url),
      });
      return new Response(null, { status: statusFor(String(url)) });
    }),
  );
  return posts;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("task actor integration", () => {
  it("creates, completes, and stays readable after the actor run settles", async () => {
    const runtime = createTestRuntime({ agent: { name: "task-actor-complete" } });

    await runtime.run(async () => {
      const posts = stubNotificationSink(() => 202);

      const record = await createTask({
        createdBy: { authenticator: "test", principalId: "user_1" },
        endpoints: [{ url: "https://caller.example/eve/v1/callback/tok-1" }],
        sessionId: "session_1",
        ttlMs: null,
      });
      const handle: TaskHandle = { taskId: record.task.taskId, taskRunId: record.taskRunId };

      expect(record.task.status).toBe("working");
      expect(record.task.taskId).toMatch(/^task_/);
      expect(record.task.taskId).not.toContain(record.taskRunId);

      const completed = await completeTask(handle, { answer: 42 });
      expect(completed).toMatchObject({ result: { answer: 42 }, status: "completed" });

      // The actor run settles on terminal; the record must remain
      // readable cross-run after completion.
      await expect(getRun(record.taskRunId).returnValue).resolves.toMatchObject({
        status: "completed",
      });
      await expect(getTask(handle)).resolves.toMatchObject({
        result: { answer: 42 },
        status: "completed",
      });

      // task.created is not routed by default; the terminal is.
      expect(posts.map((post) => post.notification.kind)).toEqual(["task.terminal"]);
      expect(posts[0]?.url).toBe("https://caller.example/eve/v1/callback/tok-1");
      expect(posts[0]?.notification.task).toMatchObject({ status: "completed" });
    });
  });

  it("routes input_required round-trips through updateTask", async () => {
    const runtime = createTestRuntime({ agent: { name: "task-actor-input" } });

    await runtime.run(async () => {
      const posts = stubNotificationSink(() => 202);

      const record = await createTask({
        endpoints: [{ url: "https://caller.example/eve/v1/callback/tok-2" }],
        sessionId: "session_2",
        ttlMs: null,
      });
      const handle: TaskHandle = { taskId: record.task.taskId, taskRunId: record.taskRunId };

      const awaiting = await requireTaskInput(handle, [inputRequest]);
      expect(awaiting).toMatchObject({ inputRequests: [inputRequest], status: "input_required" });

      const resumed = await updateTask(handle, [{ optionId: "approve", requestId: "req_1" }]);
      expect(resumed.status).toBe("working");

      const stored = await readTaskRecord({ taskRunId: handle.taskRunId });
      expect(stored.inputResponses).toEqual([{ optionId: "approve", requestId: "req_1" }]);

      await expect(updateTask(handle, [{ requestId: "req_1", text: "again" }])).rejects.toThrow(
        /not "input_required"/,
      );

      expect(posts.map((post) => post.notification.kind)).toEqual(["task.status", "task.status"]);

      await completeTask(handle, "done");
    });
  });

  it("keeps cancellation sticky and settles late commands against the terminal record", async () => {
    const runtime = createTestRuntime({ agent: { name: "task-actor-cancel" } });

    await runtime.run(async () => {
      stubNotificationSink(() => 202);

      const record = await createTask({
        endpoints: [],
        sessionId: "session_3",
        ttlMs: 60_000,
      });
      const handle: TaskHandle = { taskId: record.task.taskId, taskRunId: record.taskRunId };
      expect(record.task.ttlMs).toBe(60_000);

      const cancelled = await cancelTask(handle);
      expect(cancelled.status).toBe("cancelled");

      // Terminal is final: a late completion resolves against the
      // settled record instead of transitioning it.
      const afterComplete = await completeTask(handle, "too late");
      expect(afterComplete.status).toBe("cancelled");

      // cancelTask on a terminal task is a read, not a transition.
      await expect(cancelTask(handle)).resolves.toMatchObject({ status: "cancelled" });
    });
  });

  it("marks gone subscribers dead after a 404 and never retries them", async () => {
    const runtime = createTestRuntime({ agent: { name: "task-actor-gone" } });

    await runtime.run(async () => {
      const posts = stubNotificationSink((url) => (url.includes("gone") ? 404 : 202));

      const record = await createTask({
        endpoints: [
          { url: "https://caller.example/eve/v1/callback/gone" },
          { url: "https://caller.example/eve/v1/callback/live" },
        ],
        sessionId: "session_4",
        ttlMs: null,
      });
      const handle: TaskHandle = { taskId: record.task.taskId, taskRunId: record.taskRunId };

      await setTaskStatusMessage(handle, "progress is not routed by default");
      await requireTaskInput(handle, [inputRequest]);

      const afterStatus = await readTaskRecord({ taskRunId: handle.taskRunId });
      expect(afterStatus.endpoints).toEqual([
        { dead: true, url: "https://caller.example/eve/v1/callback/gone" },
        { url: "https://caller.example/eve/v1/callback/live" },
      ]);

      await completeTask(handle, "done");

      // First transition hit both endpoints; the dead one is skipped
      // for the terminal event.
      const urls = posts.map((post) => post.url);
      expect(urls.filter((url) => url.includes("gone"))).toHaveLength(1);
      expect(urls.filter((url) => url.includes("live"))).toHaveLength(2);
    });
  });
});
