import { describe, expect, it, vi } from "vitest";

import {
  runLogsListCommand,
  runLogsTailCommand,
  type LogsCommandDependencies,
} from "#cli/commands/logs.js";
import type { LocalSessionSummary } from "#internal/workflow/local-sessions.js";
import type { SessionLogFile } from "#internal/session-logs/files.js";

const olderSession: LocalSessionSummary = {
  createdAt: new Date("2026-07-15T20:00:00.000Z"),
  deploymentId: "generation-1",
  errorCode: undefined,
  sessionId: "wrun_older",
  status: "completed",
  title: "Older",
  trigger: "http",
  updatedAt: new Date("2026-07-15T20:01:00.000Z"),
};

const newerSession: LocalSessionSummary = {
  ...olderSession,
  sessionId: "wrun_newer",
  status: "running",
  title: "Newer",
  updatedAt: new Date("2026-07-15T20:02:00.000Z"),
};

const files: readonly SessionLogFile[] = [
  {
    modifiedAt: new Date("2026-07-15T21:00:00.000Z"),
    path: "/logs/older.log",
    sessionId: "wrun_older",
  },
  {
    modifiedAt: new Date("2026-07-15T19:00:00.000Z"),
    path: "/logs/newer.log",
    sessionId: "wrun_newer",
  },
];

describe("local session log commands", () => {
  it("lists logs by Workflow updatedAt rather than file mtime", async () => {
    const output = { log: vi.fn() };
    const dependencies = createDependencies();

    await runLogsListCommand(output, "/app", dependencies);

    expect(output.log).toHaveBeenCalledWith(
      [
        "SESSION ID  STATUS     UPDATED                   TITLE",
        "wrun_newer  running    2026-07-15T20:02:00.000Z  Newer",
        "wrun_older  completed  2026-07-15T20:01:00.000Z  Older",
      ].join("\n"),
    );
  });

  it("tails the most recently updated Workflow session by default", async () => {
    const output = { log: vi.fn(), write: vi.fn() };
    const dependencies = createDependencies();

    await runLogsTailCommand(output, "/app", undefined, { follow: true, lines: 10 }, dependencies);

    expect(dependencies.tail).toHaveBeenCalledWith("/logs/newer.log", {
      follow: true,
      lines: 10,
      write: expect.any(Function),
    });
  });

  it("tails an exact session without consulting MRU ordering", async () => {
    const output = { log: vi.fn(), write: vi.fn() };
    const dependencies = createDependencies();

    await runLogsTailCommand(
      output,
      "/app",
      "wrun_older",
      { follow: false, lines: 3 },
      dependencies,
    );

    expect(dependencies.listSessions).not.toHaveBeenCalled();
    expect(dependencies.tail).toHaveBeenCalledWith("/logs/older.log", {
      follow: false,
      lines: 3,
      write: expect.any(Function),
    });
  });
});

function createDependencies(): LogsCommandDependencies & {
  readonly listSessions: ReturnType<typeof vi.fn>;
  readonly tail: ReturnType<typeof vi.fn>;
} {
  return {
    listFiles: vi.fn().mockResolvedValue(files),
    listSessions: vi.fn().mockResolvedValue([newerSession, olderSession]),
    tail: vi.fn().mockResolvedValue(undefined),
  };
}
