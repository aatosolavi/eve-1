import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  waitForSandboxTemplatePrewarmLock,
  withSandboxTemplatePrewarmLock,
} from "#execution/sandbox/template-prewarm-lock.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const tombstoneRemoval = vi.hoisted(() => ({
  release: undefined as (() => void) | undefined,
  started: undefined as (() => void) | undefined,
}));
const recoveryIntentRemoval = vi.hoisted(() => ({
  failNext: false,
}));
const recoveryIntentRename = vi.hoisted(() => ({
  calls: 0,
  failures: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...original,
    async rm(...input: Parameters<typeof original.rm>) {
      if (recoveryIntentRemoval.failNext && String(input[0]).includes(".recovery.released-")) {
        recoveryIntentRemoval.failNext = false;
        throw Object.assign(new Error("injected recovery intent cleanup failure"), {
          code: "EBUSY",
        });
      }

      if (String(input[0]).includes(".tombstone-") && tombstoneRemoval.started !== undefined) {
        const onStarted = tombstoneRemoval.started;
        tombstoneRemoval.started = undefined;
        onStarted();
        await new Promise<void>((resolve) => {
          tombstoneRemoval.release = resolve;
        });
      }

      return original.rm(...input);
    },
  };
});

vi.mock("#shared/rename-with-retry.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("#shared/rename-with-retry.js")>();

  return {
    ...original,
    async renameWithTransientBusyRetry(sourcePath: string, destinationPath: string) {
      if (sourcePath.includes("intent-") && destinationPath.includes(".recovery.released-")) {
        recoveryIntentRename.calls += 1;
        if (recoveryIntentRename.failures > 0) {
          recoveryIntentRename.failures -= 1;
          throw Object.assign(new Error("injected recovery intent rename failure"), {
            code: "EBUSY",
          });
        }
      }

      return original.renameWithTransientBusyRetry(sourcePath, destinationPath);
    },
  };
});

const BACKEND_NAME = "docker";
const DEAD_PID = 2_147_483_647;
const TEMPLATE_KEY = "template-abc";
const createScratchDirectory = useTemporaryDirectories();

afterEach(() => {
  tombstoneRemoval.release?.();
  tombstoneRemoval.release = undefined;
  tombstoneRemoval.started = undefined;
  recoveryIntentRemoval.failNext = false;
  recoveryIntentRename.calls = 0;
  recoveryIntentRename.failures = 0;
});

function resolveLockPath(appRoot: string): string {
  return join(
    appRoot,
    ".eve",
    "sandbox-cache",
    "template-locks",
    BACKEND_NAME,
    `${TEMPLATE_KEY}.lock`,
  );
}

function resolveRecoveryRoot(appRoot: string): string {
  return `${resolveLockPath(appRoot)}.recovery`;
}

function createLockInput(appRoot: string) {
  return {
    appRoot,
    backendName: BACKEND_NAME,
    templateKey: TEMPLATE_KEY,
  };
}

async function writeLock(
  appRoot: string,
  owner: Readonly<Record<string, unknown>> | string,
  options: { readonly ageMs?: number } = {},
): Promise<string> {
  const lockPath = resolveLockPath(appRoot);

  await mkdir(lockPath, { recursive: true });
  await writeFile(
    join(lockPath, "owner.json"),
    typeof owner === "string" ? owner : `${JSON.stringify(owner)}\n`,
    "utf8",
  );

  if (options.ageMs !== undefined) {
    const modifiedAt = new Date(Date.now() - options.ageMs);
    await utimes(lockPath, modifiedAt, modifiedAt);
  }

  return lockPath;
}

async function writeRecoveryIntent(
  appRoot: string,
  owner: Readonly<Record<string, unknown>> | string,
  options: { readonly ageMs?: number; readonly name?: string } = {},
): Promise<string> {
  const recoveryPath = join(
    resolveRecoveryRoot(appRoot),
    options.name ?? `intent-${Math.random().toString(36).slice(2)}`,
  );

  await mkdir(recoveryPath, { recursive: true });
  await writeFile(
    join(recoveryPath, "owner.json"),
    typeof owner === "string" ? owner : `${JSON.stringify(owner)}\n`,
    "utf8",
  );

  if (options.ageMs !== undefined) {
    const modifiedAt = new Date(Date.now() - options.ageMs);
    await utimes(recoveryPath, modifiedAt, modifiedAt);
  }

  return recoveryPath;
}

async function releaseFixtureLock(appRoot: string): Promise<void> {
  await rm(resolveLockPath(appRoot), { force: true, recursive: true });
}

async function waitForFixtureLock(appRoot: string): Promise<void> {
  await waitForSandboxTemplatePrewarmLock(createLockInput(appRoot));
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const pending = Symbol("pending");
  let timer: NodeJS.Timeout | undefined;

  try {
    const result = await Promise.race([
      promise.then(() => true),
      new Promise<typeof pending>((resolve) => {
        timer = setTimeout(() => resolve(pending), timeoutMs);
      }),
    ]);

    return result !== pending;
  } finally {
    clearTimeout(timer);
  }
}

describe("sandbox template prewarm locks", () => {
  it("records the owning hostname and pid", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-owner-");
    let owner: unknown;

    await withSandboxTemplatePrewarmLock(createLockInput(appRoot), async () => {
      owner = JSON.parse(await readFile(join(resolveLockPath(appRoot), "owner.json"), "utf8"));
    });

    expect(owner).toMatchObject({
      hostname: hostname(),
      pid: process.pid,
    });
  });

  it("reclaims a fresh lock whose same-host owner is definitively dead", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-dead-");
    const lockPath = await writeLock(appRoot, {
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      pid: DEAD_PID,
    });
    const waiter = waitForFixtureLock(appRoot);
    const settled = await settlesWithin(waiter, 2_000);

    if (!settled) {
      await releaseFixtureLock(appRoot);
    }
    await waiter;

    expect(settled).toBe(true);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a same-host live owner even after the unknown-owner stale window", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-live-");
    const waiter = waitForFixtureLockAfterWrite(
      appRoot,
      {
        createdAt: new Date().toISOString(),
        hostname: hostname(),
        pid: process.pid,
      },
      { ageMs: 20 * 60 * 1000 },
    );

    expect(await settlesWithin(waiter, 750)).toBe(false);
    await releaseFixtureLock(appRoot);
    await waiter;
  });

  it("preserves a fresh owner recorded on another host", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-foreign-");
    const waiter = waitForFixtureLockAfterWrite(appRoot, {
      createdAt: new Date().toISOString(),
      hostname: "another-host.invalid",
      pid: DEAD_PID,
    });

    expect(await settlesWithin(waiter, 750)).toBe(false);
    await releaseFixtureLock(appRoot);
    await waiter;
  });

  it("preserves a fresh lock with malformed owner metadata", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-malformed-");
    const waiter = waitForFixtureLockAfterWrite(appRoot, "{not-json");

    expect(await settlesWithin(waiter, 750)).toBe(false);
    await releaseFixtureLock(appRoot);
    await waiter;
  });

  it("does not acquire the main lock while a live recovery lease exists", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-recovery-");
    const recoveryPath = await writeRecoveryIntent(appRoot, {
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      pid: process.pid,
      token: "recovery-owner",
    });

    const contender = withSandboxTemplatePrewarmLock(createLockInput(appRoot), async () => {});
    expect(await settlesWithin(contender, 750)).toBe(false);

    await rm(recoveryPath, { force: true, recursive: true });
    await contender;
  });

  it("reclaims a recovery lease whose same-host owner is definitively dead", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-dead-recovery-");
    const recoveryPath = await writeRecoveryIntent(appRoot, {
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      pid: DEAD_PID,
      token: "dead-recovery-owner",
    });

    await withSandboxTemplatePrewarmLock(createLockInput(appRoot), async () => {});

    await expect(stat(recoveryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reclaims stale recovery intents with unverifiable owners", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-stale-recovery-");
    const malformedPath = await writeRecoveryIntent(appRoot, "{not-json", {
      ageMs: 11 * 60 * 1000,
      name: "intent-malformed",
    });
    const foreignPath = await writeRecoveryIntent(
      appRoot,
      {
        createdAt: new Date().toISOString(),
        hostname: "another-host.invalid",
        pid: DEAD_PID,
        token: "foreign-recovery-owner",
      },
      {
        ageMs: 11 * 60 * 1000,
        name: "intent-foreign",
      },
    );

    await withSandboxTemplatePrewarmLock(createLockInput(appRoot), async () => {});

    await expect(stat(malformedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(foreignPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the main lock blocked until every live recovery intent is gone", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-recovery-barrier-");
    const owner = {
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      pid: process.pid,
    };
    const firstRecoveryPath = await writeRecoveryIntent(appRoot, owner, {
      name: "intent-first",
    });
    const secondRecoveryPath = await writeRecoveryIntent(appRoot, owner, {
      name: "intent-second",
    });

    const contender = withSandboxTemplatePrewarmLock(createLockInput(appRoot), async () => {});
    expect(await settlesWithin(contender, 750)).toBe(false);

    await rm(firstRecoveryPath, { force: true, recursive: true });
    expect(await settlesWithin(contender, 750)).toBe(false);

    await rm(secondRecoveryPath, { force: true, recursive: true });
    await contender;
  });

  it("does not remove a newer intent while stale-intent cleanup is delayed", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-recovery-generation-");
    await writeRecoveryIntent(
      appRoot,
      {
        createdAt: new Date().toISOString(),
        hostname: hostname(),
        pid: DEAD_PID,
        token: "dead-recovery-owner",
      },
      { name: "intent-dead" },
    );
    let markRemovalStarted: (() => void) | undefined;
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve;
    });
    tombstoneRemoval.started = markRemovalStarted;

    const firstContender = withSandboxTemplatePrewarmLock(createLockInput(appRoot), async () => {});
    await removalStarted;

    const liveRecoveryPath = await writeRecoveryIntent(
      appRoot,
      {
        createdAt: new Date().toISOString(),
        hostname: hostname(),
        pid: process.pid,
        token: "live-recovery-owner",
      },
      { name: "intent-live" },
    );
    const secondContender = withSandboxTemplatePrewarmLock(
      createLockInput(appRoot),
      async () => {},
    );

    tombstoneRemoval.release?.();
    tombstoneRemoval.release = undefined;
    expect(await settlesWithin(Promise.all([firstContender, secondContender]), 750)).toBe(false);
    await expect(stat(liveRecoveryPath)).resolves.toBeDefined();

    await rm(liveRecoveryPath, { force: true, recursive: true });
    await Promise.all([firstContender, secondContender]);
  });

  it("does not leave a completed intent blocking when its cleanup fails", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-recovery-cleanup-");
    const input = createLockInput(appRoot);
    recoveryIntentRemoval.failNext = true;

    await withSandboxTemplatePrewarmLock(input, async () => {});
    await withSandboxTemplatePrewarmLock(input, async () => {});
  });

  it("retries a transient failure while moving a completed intent", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-recovery-rename-");
    const input = createLockInput(appRoot);
    recoveryIntentRename.failures = 1;

    await withSandboxTemplatePrewarmLock(input, async () => {});
    await withSandboxTemplatePrewarmLock(input, async () => {});

    expect(recoveryIntentRename.calls).toBeGreaterThanOrEqual(2);
  });

  it("reclaims stale locks whose owner cannot be verified", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-stale-");
    const lockPath = await writeLock(appRoot, "{not-json", {
      ageMs: 11 * 60 * 1000,
    });

    await waitForFixtureLock(appRoot);

    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds successors out while reclaimed-lock cleanup is delayed", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-successor-");
    const input = createLockInput(appRoot);
    const lockPath = await writeLock(appRoot, {
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      pid: DEAD_PID,
    });
    let markRemovalStarted: (() => void) | undefined;
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve;
    });
    tombstoneRemoval.started = markRemovalStarted;

    const reclaim = waitForFixtureLock(appRoot);
    await removalStarted;

    let enterSuccessor: (() => void) | undefined;
    const successorEntered = new Promise<void>((resolve) => {
      enterSuccessor = resolve;
    });
    let releaseSuccessor: (() => void) | undefined;
    const holdSuccessor = new Promise<void>((resolve) => {
      releaseSuccessor = resolve;
    });
    const successor = withSandboxTemplatePrewarmLock(input, async () => {
      enterSuccessor?.();
      await holdSuccessor;
    });

    expect(await settlesWithin(successorEntered, 750)).toBe(false);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    tombstoneRemoval.release?.();
    tombstoneRemoval.release = undefined;
    await successorEntered;
    await expect(stat(lockPath)).resolves.toBeDefined();

    releaseSuccessor?.();
    await Promise.all([reclaim, successor]);
  });

  it("does not release a successor when a reclaimed owner finishes late", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-late-owner-");
    const input = createLockInput(appRoot);
    const lockPath = resolveLockPath(appRoot);
    let markFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withSandboxTemplatePrewarmLock(input, async () => {
      markFirstEntered?.();
      await holdFirst;
    });
    await firstEntered;

    const firstOwner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ ...firstOwner, hostname: "another-host.invalid" })}\n`,
    );
    const staleAt = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(lockPath, staleAt, staleAt);

    let markSuccessorEntered: (() => void) | undefined;
    const successorEntered = new Promise<void>((resolve) => {
      markSuccessorEntered = resolve;
    });
    let releaseSuccessor: (() => void) | undefined;
    const holdSuccessor = new Promise<void>((resolve) => {
      releaseSuccessor = resolve;
    });
    const successor = withSandboxTemplatePrewarmLock(input, async () => {
      markSuccessorEntered?.();
      await holdSuccessor;
    });
    await successorEntered;

    releaseFirst?.();
    await first;
    await expect(stat(lockPath)).resolves.toBeDefined();

    releaseSuccessor?.();
    await successor;
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds successors out while an owner release is delayed", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-release-");
    const input = createLockInput(appRoot);
    const lockPath = resolveLockPath(appRoot);
    let markFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withSandboxTemplatePrewarmLock(input, async () => {
      markFirstEntered?.();
      await holdFirst;
    });
    await firstEntered;

    let markRemovalStarted: (() => void) | undefined;
    const removalStarted = new Promise<void>((resolve) => {
      markRemovalStarted = resolve;
    });
    tombstoneRemoval.started = markRemovalStarted;
    releaseFirst?.();
    await removalStarted;

    let markSuccessorEntered: (() => void) | undefined;
    const successorEntered = new Promise<void>((resolve) => {
      markSuccessorEntered = resolve;
    });
    let releaseSuccessor: (() => void) | undefined;
    const holdSuccessor = new Promise<void>((resolve) => {
      releaseSuccessor = resolve;
    });
    const successor = withSandboxTemplatePrewarmLock(input, async () => {
      markSuccessorEntered?.();
      await holdSuccessor;
    });

    expect(await settlesWithin(successorEntered, 750)).toBe(false);
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    tombstoneRemoval.release?.();
    tombstoneRemoval.release = undefined;
    await first;
    await successorEntered;
    await expect(stat(lockPath)).resolves.toBeDefined();

    releaseSuccessor?.();
    await successor;
  });

  it("serializes simultaneous reclaimers without deleting a successor lock", async () => {
    const appRoot = await createScratchDirectory("eve-prewarm-lock-race-");
    const input = createLockInput(appRoot);
    await writeLock(appRoot, {
      createdAt: new Date().toISOString(),
      hostname: hostname(),
      pid: DEAD_PID,
    });
    let activeCallbacks = 0;
    let callbackCount = 0;
    let maximumActiveCallbacks = 0;

    const run = async () => {
      await withSandboxTemplatePrewarmLock(input, async () => {
        callbackCount += 1;
        activeCallbacks += 1;
        maximumActiveCallbacks = Math.max(maximumActiveCallbacks, activeCallbacks);
        await new Promise((resolve) => setTimeout(resolve, 500));
        activeCallbacks -= 1;
      });
    };

    await Promise.all([run(), run()]);

    expect(callbackCount).toBe(2);
    expect(maximumActiveCallbacks).toBe(1);
    const lockParent = dirname(resolveLockPath(appRoot));
    expect((await readdir(lockParent)).filter((name) => name.includes(".tombstone-"))).toEqual([]);
  });
});

async function waitForFixtureLockAfterWrite(
  appRoot: string,
  owner: Readonly<Record<string, unknown>> | string,
  options?: { readonly ageMs?: number },
): Promise<void> {
  await writeLock(appRoot, owner, options);
  await waitForFixtureLock(appRoot);
}
