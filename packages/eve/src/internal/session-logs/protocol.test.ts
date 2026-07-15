import { describe, expect, it } from "vitest";

import {
  areSessionLogsEnabled,
  developmentSessionLogEventSchema,
  isSafeSessionLogId,
} from "#internal/session-logs/protocol.js";

describe("development session log protocol", () => {
  it("records by default and honors the exact disable flag", () => {
    expect(areSessionLogsEnabled({})).toBe(true);
    expect(areSessionLogsEnabled({ EVE_SESSION_LOGS: "0" })).toBe(false);
    expect(areSessionLogsEnabled({ EVE_SESSION_LOGS: "false" })).toBe(true);
  });

  it("keeps session IDs inside the log directory", () => {
    expect(isSafeSessionLogId("wrun_01J00000000000000000000000")).toBe(true);
    expect(isSafeSessionLogId("../outside")).toBe(false);
    expect(isSafeSessionLogId("nested/session")).toBe(false);
  });

  it("parses complete output events and rejects unknown fields", () => {
    expect(
      developmentSessionLogEventSchema.safeParse({
        at: "2026-07-15T20:00:00.000Z",
        sessionId: "wrun_session",
        stream: "stdout",
        text: "hello\n",
        type: "process.output",
      }).success,
    ).toBe(true);
    expect(
      developmentSessionLogEventSchema.safeParse({
        at: "2026-07-15T20:00:00.000Z",
        extra: true,
        sessionId: "wrun_session",
        stream: "stdout",
        text: "hello\n",
        type: "process.output",
      }).success,
    ).toBe(false);
  });
});
