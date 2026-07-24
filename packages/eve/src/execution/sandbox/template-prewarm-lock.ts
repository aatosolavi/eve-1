import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import { renameWithTransientBusyRetry } from "#shared/rename-with-retry.js";

const LOCK_POLL_MS = 250;
const LOCK_TIMEOUT_MS = 15 * 60 * 1000;
const RECOVERY_HEARTBEAT_MS = 30_000;
// Unknown owners need time to finish, but their fallback must become
// reclaimable before a waiter reaches its timeout.
const UNKNOWN_OWNER_STALE_MS = 10 * 60 * 1000;

interface PrewarmLockOwner {
  readonly createdAt?: string;
  readonly hostname?: string;
  readonly pid?: number;
  readonly token?: string;
}

type PrewarmLockOwnerLiveness = "alive" | "dead" | "foreign" | "unknown";
type PrewarmLockReclaimReason = "dead" | "stale";

export interface SandboxTemplatePrewarmLockInput {
  readonly appRoot: string;
  readonly backendName: string;
  readonly log?: (message: string) => void;
  readonly templateKey: string;
}

export async function waitForSandboxTemplatePrewarmLock(
  input: SandboxTemplatePrewarmLockInput,
): Promise<void> {
  await waitForLockRelease(resolveSandboxTemplatePrewarmLockPath(input), input.log);
}

export async function withSandboxTemplatePrewarmLock<T>(
  input: SandboxTemplatePrewarmLockInput,
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = resolveSandboxTemplatePrewarmLockPath(input);
  const ownerToken = await acquireLock(lockPath);
  try {
    return await callback();
  } finally {
    await releaseOwnedLockDirectory(lockPath, ownerToken).catch(() => {});
  }
}

function resolveSandboxTemplatePrewarmLockPath(input: SandboxTemplatePrewarmLockInput): string {
  return join(
    resolveSandboxCacheDirectory(input.appRoot),
    "template-locks",
    input.backendName,
    `${input.templateKey}.lock`,
  );
}

async function acquireLock(lockPath: string): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    await mkdir(dirname(lockPath), { recursive: true });

    if (await waitForRecoveryIntents(lockPath, startedAt)) {
      continue;
    }

    try {
      await mkdir(lockPath);
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      await waitForExistingLock(lockPath, startedAt, undefined);
      continue;
    }

    if ((await listRecoveryIntentPaths(lockPath)).length > 0) {
      await removeLockDirectory(lockPath).catch(() => {});
      await waitForRecoveryIntents(lockPath, startedAt);
      continue;
    }

    const ownerToken = randomUUID();
    try {
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({
          createdAt: new Date().toISOString(),
          hostname: hostname(),
          pid: process.pid,
          token: ownerToken,
        } satisfies PrewarmLockOwner)}\n`,
      );
      return ownerToken;
    } catch (error) {
      await removeLockDirectory(lockPath).catch(() => {});
      throw error;
    }
  }
}

async function waitForLockRelease(
  lockPath: string,
  log: ((message: string) => void) | undefined,
): Promise<void> {
  const startedAt = Date.now();
  let nextLogAt = startedAt + 10_000;
  for (;;) {
    if (await waitForRecoveryIntents(lockPath, startedAt)) {
      continue;
    }

    try {
      await stat(lockPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
    const now = Date.now();
    if (log !== undefined && now >= nextLogAt) {
      const elapsedSeconds = Math.round((now - startedAt) / 1000);
      log(
        elapsedSeconds === 0
          ? "waiting for sandbox template prewarm to finish"
          : `waiting for sandbox template prewarm to finish (${elapsedSeconds}s elapsed)`,
      );
      nextLogAt = now + 10_000;
    }
    await waitForExistingLock(lockPath, startedAt, log);
  }
}

async function waitForExistingLock(
  lockPath: string,
  startedAt: number,
  log: ((message: string) => void) | undefined,
): Promise<void> {
  const lockStat = await stat(lockPath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });
  if (lockStat === null) {
    return;
  }

  const reclaimReason = resolveReclaimReason(
    await resolvePrewarmLockOwnerLiveness(lockPath),
    Date.now() - lockStat.mtimeMs,
  );

  if (reclaimReason !== undefined) {
    const reclaimedReason = await tryReclaimLock(lockPath);

    if (reclaimedReason === "dead") {
      log?.("removing sandbox template prewarm lock held by a dead process");
    } else if (reclaimedReason === "stale") {
      log?.("removing stale sandbox template prewarm lock");
    }
    if (reclaimedReason !== undefined) {
      return;
    }
  }

  throwIfLockWaitTimedOut(lockPath, startedAt);
  await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
}

function resolveReclaimReason(
  liveness: PrewarmLockOwnerLiveness,
  lockAgeMs: number,
): PrewarmLockReclaimReason | undefined {
  if (liveness === "dead") {
    return "dead";
  }

  if (liveness !== "alive" && lockAgeMs > UNKNOWN_OWNER_STALE_MS) {
    return "stale";
  }

  return undefined;
}

async function tryReclaimLock(lockPath: string): Promise<PrewarmLockReclaimReason | undefined> {
  const releaseRecovery = await createRecoveryIntent(lockPath);

  try {
    return await reclaimLockWhileRecoveryIsHeld(lockPath);
  } finally {
    await releaseRecovery();
  }
}

async function reclaimLockWhileRecoveryIsHeld(
  lockPath: string,
): Promise<PrewarmLockReclaimReason | undefined> {
  // Re-read immediately before the atomic claim so another waiter never acts
  // on owner metadata observed before a replacement lock was acquired.
  const lockStat = await stat(lockPath).catch((error: unknown) => {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  });

  if (lockStat === null) {
    return undefined;
  }

  const reclaimReason = resolveReclaimReason(
    await resolvePrewarmLockOwnerLiveness(lockPath),
    Date.now() - lockStat.mtimeMs,
  );

  if (reclaimReason === undefined) {
    return undefined;
  }

  const tombstonePath = `${lockPath}.tombstone-${process.pid}-${randomUUID()}`;

  try {
    await rename(lockPath, tombstonePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  // Delete only the claimed path. Every outstanding recovery intent keeps
  // successors from acquiring the original name until cleanup completes.
  await rm(tombstonePath, { force: true, recursive: true }).catch(() => {});
  return reclaimReason;
}

async function createRecoveryIntent(lockPath: string): Promise<() => Promise<void>> {
  const recoveryRoot = resolveRecoveryRoot(lockPath);
  const ownerToken = randomUUID();
  const recoveryPath = join(recoveryRoot, `intent-${ownerToken}`);

  await mkdir(recoveryRoot, { recursive: true });
  await mkdir(recoveryPath);

  try {
    await writeFile(
      join(recoveryPath, "owner.json"),
      `${JSON.stringify({
        createdAt: new Date().toISOString(),
        hostname: hostname(),
        pid: process.pid,
        token: ownerToken,
      } satisfies PrewarmLockOwner)}\n`,
    );
  } catch (error) {
    await removeRecoveryIntent(recoveryPath).catch(() => {});
    throw error;
  }

  return createRecoveryIntentRelease(recoveryPath);
}

function createRecoveryIntentRelease(recoveryPath: string): () => Promise<void> {
  let releaseRequested = false;
  let activeRelease: Promise<void> | undefined;
  let releaseRetryTimer: ReturnType<typeof setTimeout> | undefined;

  const heartbeat = () => {
    const now = new Date();
    void utimes(recoveryPath, now, now).catch(() => {});
  };
  const scheduleReleaseRetry = () => {
    if (releaseRetryTimer !== undefined) {
      return;
    }

    releaseRetryTimer = setTimeout(() => {
      releaseRetryTimer = undefined;
      void attemptRelease().catch(() => {});
    }, LOCK_POLL_MS);
    releaseRetryTimer.unref();
  };
  const attemptRelease = (): Promise<void> => {
    if (activeRelease !== undefined) {
      return activeRelease;
    }

    const attempt = removeRecoveryIntent(recoveryPath);
    activeRelease = attempt;
    void attempt.then(
      () => {
        clearInterval(timer);
        if (releaseRetryTimer !== undefined) {
          clearTimeout(releaseRetryTimer);
          releaseRetryTimer = undefined;
        }
        activeRelease = undefined;
      },
      () => {
        activeRelease = undefined;
        heartbeat();
        scheduleReleaseRetry();
      },
    );
    return attempt;
  };
  const timer = setInterval(() => {
    if (releaseRequested) {
      void attemptRelease().catch(() => {});
    } else {
      heartbeat();
    }
  }, RECOVERY_HEARTBEAT_MS);
  timer.unref();

  return async () => {
    releaseRequested = true;
    await attemptRelease().catch(() => {});
  };
}

async function waitForRecoveryIntents(lockPath: string, startedAt: number): Promise<boolean> {
  const recoveryPaths = await listRecoveryIntentPaths(lockPath);
  if (recoveryPaths.length === 0) {
    return false;
  }

  await Promise.all(
    recoveryPaths.map(async (recoveryPath) => {
      const recoveryStat = await stat(recoveryPath).catch((error: unknown) => {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      });
      if (recoveryStat === null) {
        return;
      }

      const reclaimReason = resolveReclaimReason(
        await resolvePrewarmLockOwnerLiveness(recoveryPath),
        Date.now() - recoveryStat.mtimeMs,
      );
      if (reclaimReason !== undefined) {
        // Intent paths contain a random generation and are never reused, so a
        // delayed cleaner can only remove the generation it inspected.
        await removeRecoveryIntent(recoveryPath).catch(() => {});
      }
    }),
  );

  if ((await listRecoveryIntentPaths(lockPath)).length === 0) {
    return false;
  }

  throwIfLockWaitTimedOut(resolveRecoveryRoot(lockPath), startedAt);
  await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  return true;
}

async function releaseOwnedLockDirectory(lockPath: string, ownerToken: string): Promise<void> {
  const releaseRecovery = await createRecoveryIntent(lockPath);
  try {
    await removeOwnedLockDirectory(lockPath, ownerToken);
  } finally {
    await releaseRecovery();
  }
}

async function removeOwnedLockDirectory(lockPath: string, ownerToken: string): Promise<void> {
  const owner = await readPrewarmLockOwner(lockPath);
  if (owner?.token !== ownerToken) {
    return;
  }

  await removeLockDirectory(lockPath);
}

async function removeLockDirectory(lockPath: string): Promise<void> {
  const tombstonePath = `${lockPath}.tombstone-${process.pid}-${randomUUID()}`;

  try {
    await rename(lockPath, tombstonePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  await rm(tombstonePath, { force: true, recursive: true }).catch(() => {});
}

async function removeRecoveryIntent(recoveryPath: string): Promise<void> {
  const releasedPath = `${dirname(recoveryPath)}.released-${process.pid}-${randomUUID()}`;

  try {
    await renameWithTransientBusyRetry(recoveryPath, releasedPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  // The intent stops blocking as soon as it leaves the recovery root. Cleanup
  // failure cannot wedge future lock acquisitions.
  await rm(releasedPath, { force: true, recursive: true }).catch(() => {});
}

function resolveRecoveryRoot(lockPath: string): string {
  return `${lockPath}.recovery`;
}

async function listRecoveryIntentPaths(lockPath: string): Promise<string[]> {
  const recoveryRoot = resolveRecoveryRoot(lockPath);

  try {
    return (await readdir(recoveryRoot))
      .filter((entry) => entry.startsWith("intent-") && !entry.includes(".tombstone-"))
      .map((entry) => join(recoveryRoot, entry));
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function throwIfLockWaitTimedOut(lockPath: string, startedAt: number): void {
  if (Date.now() - startedAt <= LOCK_TIMEOUT_MS) {
    return;
  }

  throw new Error(
    `Timed out waiting for sandbox template prewarm lock "${lockPath}" after ${LOCK_TIMEOUT_MS}ms.`,
  );
}

async function resolvePrewarmLockOwnerLiveness(
  lockPath: string,
): Promise<PrewarmLockOwnerLiveness> {
  const owner = await readPrewarmLockOwner(lockPath);

  if (owner === undefined || owner.hostname === undefined) {
    return "unknown";
  }

  if (owner.hostname !== hostname()) {
    return "foreign";
  }

  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return "unknown";
  }

  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) {
      return "dead";
    }

    if (hasErrorCode(error, "EPERM")) {
      return "alive";
    }

    return "unknown";
  }
}

async function readPrewarmLockOwner(lockPath: string): Promise<PrewarmLockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));

    if (typeof value !== "object" || value === null) {
      return undefined;
    }

    return value as PrewarmLockOwner;
  } catch {
    return undefined;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isFileExistsError(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function isNotFoundError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}
