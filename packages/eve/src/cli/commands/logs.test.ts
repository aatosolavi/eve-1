import { describe, expect, it, vi } from "vitest";

import {
  runLogsListCommand,
  runLogsTailCommand,
  type LogsCommandDependencies,
} from "#cli/commands/logs.js";
import type { DevelopmentLogFile } from "#internal/dev-logs/files.js";

const files: readonly DevelopmentLogFile[] = [
  {
    logId: "older-invocation",
    modifiedAt: new Date("2026-07-15T20:00:00.000Z"),
    path: "/logs/older-invocation.log",
  },
  {
    logId: "newer-invocation",
    modifiedAt: new Date("2026-07-15T21:00:00.000Z"),
    path: "/logs/newer-invocation.log",
  },
];

describe("local development log commands", () => {
  it("lists invocation logs by file recency", async () => {
    const output = { log: vi.fn() };

    await runLogsListCommand(output, "/app", createDependencies());

    expect(output.log).toHaveBeenCalledWith(
      [
        "LOG ID            UPDATED",
        "newer-invocation  2026-07-15T21:00:00.000Z",
        "older-invocation  2026-07-15T20:00:00.000Z",
      ].join("\n"),
    );
  });

  it.each([undefined, "mru"])("tails the most recent invocation for %s", async (logId) => {
    const output = { log: vi.fn(), write: vi.fn() };
    const dependencies = createDependencies();

    await runLogsTailCommand(output, "/app", logId, { follow: true, lines: 10 }, dependencies);

    expect(dependencies.tail).toHaveBeenCalledWith("/logs/newer-invocation.log", {
      follow: true,
      lines: 10,
      write: expect.any(Function),
    });
  });

  it("tails an exact invocation log", async () => {
    const output = { log: vi.fn(), write: vi.fn() };
    const dependencies = createDependencies();

    await runLogsTailCommand(
      output,
      "/app",
      "older-invocation",
      { follow: false, lines: 3 },
      dependencies,
    );

    expect(dependencies.tail).toHaveBeenCalledWith("/logs/older-invocation.log", {
      follow: false,
      lines: 3,
      write: expect.any(Function),
    });
  });
});

function createDependencies(): LogsCommandDependencies & {
  readonly tail: ReturnType<typeof vi.fn>;
} {
  return {
    listFiles: vi.fn().mockResolvedValue(files),
    tail: vi.fn().mockResolvedValue(undefined),
  };
}
