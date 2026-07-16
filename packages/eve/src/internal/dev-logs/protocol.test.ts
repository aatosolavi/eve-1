import { describe, expect, it } from "vitest";

import {
  areDevelopmentLogsEnabled,
  developmentLogBatchSchema,
  developmentLogEventSchema,
  isSafeDevelopmentLogId,
} from "#internal/dev-logs/protocol.js";

describe("development log protocol", () => {
  it("records by default and honors the exact disable flag", () => {
    expect(areDevelopmentLogsEnabled({})).toBe(true);
    expect(areDevelopmentLogsEnabled({ EVE_DEV_LOGS: "0" })).toBe(false);
    expect(areDevelopmentLogsEnabled({ EVE_DEV_LOGS: "false" })).toBe(true);
  });

  it("keeps invocation IDs inside the log directory", () => {
    expect(isSafeDevelopmentLogId("0190fcf2-8d0e-7000-8000-000000000000")).toBe(true);
    expect(isSafeDevelopmentLogId("../outside")).toBe(false);
    expect(isSafeDevelopmentLogId("nested/invocation")).toBe(false);
  });

  it("accepts global output with optional session correlation", () => {
    expect(
      developmentLogEventSchema.safeParse({
        at: "2026-07-15T20:00:00.000Z",
        process: "worker",
        stream: "stdout",
        text: "worker booted\n",
        type: "process.output",
      }).success,
    ).toBe(true);
    expect(
      developmentLogEventSchema.safeParse({
        at: "2026-07-15T20:00:00.000Z",
        process: "worker",
        sessionId: "wrun_session",
        stream: "stderr",
        text: "tool failed\n",
        type: "process.output",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown fields and unbounded batches", () => {
    const event = {
      at: "2026-07-15T20:00:00.000Z",
      process: "worker",
      stream: "stdout",
      text: "hello\n",
      type: "process.output",
    } as const;
    expect(developmentLogBatchSchema.safeParse({ events: [event] }).success).toBe(true);
    expect(developmentLogBatchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(developmentLogEventSchema.safeParse({ ...event, extra: true }).success).toBe(false);
  });
});
