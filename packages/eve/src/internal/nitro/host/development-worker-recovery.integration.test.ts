import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isRestorableDevelopmentWorker } from "#internal/nitro/host/development-worker-recovery.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (dir) => await rm(dir, { force: true, recursive: true })),
  );
});

async function createAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-worker-recovery-"));
  temporaryDirectories.push(appRoot);
  return appRoot;
}

describe("isRestorableDevelopmentWorker", () => {
  it("accepts a persisted worker whose entry exists inside its dev-hosts workspace", async () => {
    const appRoot = await createAppRoot();
    const workspaceRoot = join(appRoot, ".eve", "dev-hosts", "workspace-1");
    const entry = join(workspaceRoot, "output", "index.mjs");
    await mkdir(join(workspaceRoot, "output"), { recursive: true });
    await writeFile(entry, "export default {};\n");

    expect(isRestorableDevelopmentWorker({ entry, workerData: {}, workspaceRoot }, appRoot)).toBe(
      true,
    );
  });

  it("rejects a workspace outside the app's dev-hosts directory", async () => {
    const appRoot = await createAppRoot();
    const workspaceRoot = join(appRoot, "elsewhere");
    const entry = join(workspaceRoot, "index.mjs");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(entry, "export default {};\n");

    expect(isRestorableDevelopmentWorker({ entry, workerData: {}, workspaceRoot }, appRoot)).toBe(
      false,
    );
  });

  it("rejects an entry that escapes its workspace", async () => {
    const appRoot = await createAppRoot();
    const workspaceRoot = join(appRoot, ".eve", "dev-hosts", "workspace-1");
    const entry = join(appRoot, ".eve", "dev-hosts", "other", "index.mjs");
    await mkdir(join(appRoot, ".eve", "dev-hosts", "other"), { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(entry, "export default {};\n");

    expect(isRestorableDevelopmentWorker({ entry, workerData: {}, workspaceRoot }, appRoot)).toBe(
      false,
    );
  });

  it("rejects a worker whose entry file no longer exists", async () => {
    const appRoot = await createAppRoot();
    const workspaceRoot = join(appRoot, ".eve", "dev-hosts", "workspace-1");
    const entry = join(workspaceRoot, "output", "index.mjs");
    await mkdir(join(workspaceRoot, "output"), { recursive: true });

    expect(isRestorableDevelopmentWorker({ entry, workerData: {}, workspaceRoot }, appRoot)).toBe(
      false,
    );
  });
});
