import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DevelopmentLog } from "#internal/dev-logs/development-log.js";
import { listDevelopmentLogFiles } from "#internal/dev-logs/files.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("development log", () => {
  it("keeps output from multiple sessions in the invocation-owned file", async () => {
    const appRoot = await createScratchDirectory("eve-development-log-");
    const log = await DevelopmentLog.open({ appRoot, logId: "dev-invocation" });

    await log.appendOutputEvents([
      {
        at: "2026-07-16T18:00:00.000Z",
        process: "worker",
        sessionId: "wrun_first",
        stream: "stdout",
        text: "first session\n",
        type: "process.output",
      },
      {
        at: "2026-07-16T18:00:01.000Z",
        process: "worker",
        sessionId: "wrun_second",
        stream: "stderr",
        text: "second session failure\n",
        type: "process.output",
      },
    ]);
    await log.close();

    const files = await listDevelopmentLogFiles(appRoot);
    expect(files).toHaveLength(1);
    expect(files[0]?.logId).toBe("dev-invocation");
    const source = await readFile(log.path, "utf8");
    expect(source).toContain("session=wrun_first");
    expect(source).toContain("session=wrun_second");
    expect(source).toContain("first session");
    expect(source).toContain("second session failure");
  });
});
