import { describe, expect, it } from "vitest";

import type { InputRequest } from "#runtime/input/types.js";
import { readBackgroundElection, taskElectionSchema } from "#runtime/tasks/election.js";
import {
  DEFAULT_NOTIFICATION_ROUTES,
  detailedTaskSchema,
  isTerminalStatus,
  taskNotificationSchema,
  toCreateTaskResult,
  type DetailedTask,
  type Task,
} from "#runtime/tasks/types.js";

const baseTask = {
  createdAt: "2026-07-23T00:00:00.000Z",
  lastUpdatedAt: "2026-07-23T00:00:01.000Z",
  taskId: "task_5c1c19f3-9f7d-4a8e-9a9e-0f2f9f6d4b1a",
  ttlMs: null,
} as const;

const inputRequest: InputRequest = {
  action: {
    callId: "call_1",
    input: { city: "Lisbon" },
    kind: "tool-call",
    toolName: "get_weather",
  },
  prompt: "Allow get_weather?",
  requestId: "req_1",
};

describe("detailedTaskSchema", () => {
  it("round-trips every status variant", () => {
    const variants: DetailedTask[] = [
      { ...baseTask, status: "working" },
      { ...baseTask, inputRequests: [inputRequest], status: "input_required" },
      { ...baseTask, result: { ok: true }, status: "completed" },
      { ...baseTask, error: { data: { code: 500 }, message: "boom" }, status: "failed" },
      { ...baseTask, status: "cancelled" },
    ];
    for (const variant of variants) {
      expect(detailedTaskSchema.parse(variant)).toEqual(variant);
    }
  });

  it("rejects variant payloads on the wrong status", () => {
    expect(
      detailedTaskSchema.safeParse({ ...baseTask, result: "late", status: "failed" }).success,
    ).toBe(false);
    expect(
      detailedTaskSchema.safeParse({ ...baseTask, inputRequests: [], status: "working" }).success,
    ).toBe(false);
  });

  it("requires the variant payload where the contract demands one", () => {
    expect(detailedTaskSchema.safeParse({ ...baseTask, status: "completed" }).success).toBe(false);
    expect(detailedTaskSchema.safeParse({ ...baseTask, status: "failed" }).success).toBe(false);
    expect(detailedTaskSchema.safeParse({ ...baseTask, status: "input_required" }).success).toBe(
      false,
    );
  });
});

describe("taskNotificationSchema", () => {
  it("round-trips an envelope carrying the full snapshot", () => {
    const notification = {
      kind: "task.terminal",
      task: { ...baseTask, result: "done", status: "completed" },
    };
    expect(taskNotificationSchema.parse(notification)).toEqual(notification);
  });

  it("rejects unknown kinds", () => {
    expect(
      taskNotificationSchema.safeParse({
        kind: "task.deleted",
        task: { ...baseTask, status: "working" },
      }).success,
    ).toBe(false);
  });
});

describe("isTerminalStatus", () => {
  it("marks exactly completed, failed, and cancelled as terminal", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
    expect(isTerminalStatus("working")).toBe(false);
    expect(isTerminalStatus("input_required")).toBe(false);
  });
});

describe("DEFAULT_NOTIFICATION_ROUTES", () => {
  it("routes only wake-worthy kinds", () => {
    expect(DEFAULT_NOTIFICATION_ROUTES).toEqual(["task.status", "task.terminal"]);
  });
});

describe("toCreateTaskResult", () => {
  it("projects the flat placeholder shape", () => {
    const task: Task = { ...baseTask, status: "working" };
    expect(toCreateTaskResult(task)).toEqual({
      createdAt: baseTask.createdAt,
      lastUpdatedAt: baseTask.lastUpdatedAt,
      status: "working",
      taskId: baseTask.taskId,
      ttlMs: null,
    });
  });

  it("keeps optional fields only when present", () => {
    const task: Task = {
      ...baseTask,
      pollIntervalMs: 2_000,
      status: "working",
      statusMessage: "starting",
    };
    expect(toCreateTaskResult(task)).toMatchObject({
      pollIntervalMs: 2_000,
      statusMessage: "starting",
    });
  });
});

describe("readBackgroundElection", () => {
  it("returns undefined when no election was recorded", () => {
    expect(readBackgroundElection(undefined)).toBeUndefined();
  });

  it("normalizes an empty election to unlimited retention", () => {
    expect(readBackgroundElection({})).toEqual({ ttlMs: null });
  });

  it("passes an explicit ttl through", () => {
    expect(readBackgroundElection({ ttlMs: 60_000 })).toEqual({ ttlMs: 60_000 });
  });

  it("rejects unknown election fields at the schema", () => {
    expect(taskElectionSchema.safeParse({ retainForever: true }).success).toBe(false);
  });
});
