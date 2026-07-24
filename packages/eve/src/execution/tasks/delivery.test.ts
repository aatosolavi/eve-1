import { describe, expect, it } from "vitest";

import type { DeliverPayload } from "#channel/types.js";
import {
  formatTaskOutcomeMessage,
  payloadCarriesTaskNotifications,
  readTaskNotifications,
  sanitizeInboundDeliverPayload,
  splitTaskNotifications,
} from "#execution/tasks/delivery.js";
import type { TaskNotification } from "#runtime/tasks/types.js";

const notification: TaskNotification = {
  kind: "task.terminal",
  task: {
    createdAt: "2026-07-23T00:00:00.000Z",
    lastUpdatedAt: "2026-07-23T00:00:01.000Z",
    result: { ok: true },
    status: "completed",
    taskId: "task_1",
    ttlMs: null,
  },
};

describe("payloadCarriesTaskNotifications", () => {
  it("detects the reserved field structurally", () => {
    expect(payloadCarriesTaskNotifications({ taskNotifications: [notification] })).toBe(true);
    expect(payloadCarriesTaskNotifications({ taskNotifications: [] })).toBe(false);
    expect(payloadCarriesTaskNotifications({ message: "hi" })).toBe(false);
  });
});

describe("readTaskNotifications", () => {
  it("validates entries and drops malformed ones", () => {
    const payload: DeliverPayload = {
      taskNotifications: [notification, { kind: "task.terminal", task: { taskId: "broken" } }],
    };
    expect(readTaskNotifications(payload)).toEqual([notification]);
  });
});

describe("splitTaskNotifications", () => {
  it("returns the payload untouched when the field is absent", () => {
    const payload = { message: "hi" };
    expect(splitTaskNotifications(payload)).toEqual({ notifications: [], rest: payload });
  });

  it("splits notifications from a mixed payload", () => {
    const { notifications, rest } = splitTaskNotifications({
      message: "hi",
      taskNotifications: [notification],
    });
    expect(notifications).toEqual([notification]);
    expect(rest).toEqual({ message: "hi" });
  });

  it("returns rest undefined for a pure task payload", () => {
    const { notifications, rest } = splitTaskNotifications({
      taskNotifications: [notification],
    });
    expect(notifications).toEqual([notification]);
    expect(rest).toBeUndefined();
  });
});

describe("sanitizeInboundDeliverPayload", () => {
  it("strips the reserved field and preserves everything else", () => {
    expect(
      sanitizeInboundDeliverPayload({
        adapterMetadata: { deliverySequence: 1 },
        message: "hi",
        taskNotifications: [notification],
      }),
    ).toEqual({ adapterMetadata: { deliverySequence: 1 }, message: "hi" });
  });

  it("returns clean payloads by reference", () => {
    const payload = { message: "hi" };
    expect(sanitizeInboundDeliverPayload(payload)).toBe(payload);
  });
});

describe("formatTaskOutcomeMessage", () => {
  it("carries the result inline for completed tasks", () => {
    const message = formatTaskOutcomeMessage(notification.task);
    expect(message).toContain("task_1");
    expect(message).toContain("completed");
    expect(JSON.parse(message.split("\n")[1] ?? "")).toEqual({
      result: { ok: true },
      status: "completed",
      taskId: "task_1",
    });
  });

  it("carries the error inline for failed tasks", () => {
    const message = formatTaskOutcomeMessage({
      createdAt: "2026-07-23T00:00:00.000Z",
      error: { message: "boom" },
      lastUpdatedAt: "2026-07-23T00:00:01.000Z",
      status: "failed",
      taskId: "task_2",
      ttlMs: null,
    });
    expect(JSON.parse(message.split("\n")[1] ?? "")).toEqual({
      error: { message: "boom" },
      status: "failed",
      taskId: "task_2",
    });
  });
});
