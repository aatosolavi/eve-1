import { describe, expect, it } from "vitest";

import { emitSandboxOutput } from "#execution/sandbox/output-events.js";
import { installDevelopmentLogOutputCapture } from "#internal/dev-logs/output-capture.js";
import type { DevelopmentLogEvent } from "#internal/dev-logs/protocol.js";

describe("development log output capture", () => {
  it("records process and sandbox output without requiring a session", () => {
    const events: DevelopmentLogEvent[] = [];
    const restore = installDevelopmentLogOutputCapture("parent", (event) => events.push(event));
    try {
      process.stdout.write("");
      emitSandboxOutput({ sandboxId: "sbx_boot", stream: "stderr", text: "boot failure\n" });
    } finally {
      restore();
    }

    expect(events).toEqual([
      expect.objectContaining({
        process: "parent",
        stream: "stdout",
        text: "",
        type: "process.output",
      }),
      expect.objectContaining({
        sandboxId: "sbx_boot",
        stream: "stderr",
        text: "boot failure\n",
        type: "sandbox.output",
      }),
    ]);
    expect(events.every((event) => event.sessionId === undefined)).toBe(true);
  });
});
