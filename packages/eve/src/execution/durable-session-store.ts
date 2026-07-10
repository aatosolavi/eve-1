/**
 * Durable session storage.
 *
 * Session-mutating steps return the current snapshot inside
 * {@link DurableSessionState}; Workflow step results are the atomic
 * persistence boundary for session program memory. The legacy
 * `"eve.session"` stream remains as a fallback for old in-flight
 * sessions that only carry a small state handle.
 *
 * The driver workflow run is pinned to the deployment that called
 * `start()`; child turn workflows run on latest. Both
 * {@link DurableSessionState} and {@link DurableSessionSnapshot} carry
 * a `version` so a pinned driver can ferry shapes written by newer
 * steps. Adding optional fields is forward-compatible (devalue
 * preserves unknown POJO fields); shape-breaking changes bump
 * `version` and add a migrator.
 */
import { migrateDurableSessionSnapshot } from "#execution/durable-session-migrations/snapshot.js";
import type { DurableSession, DurableSessionState } from "#execution/durable-session-state.js";
import { getRun } from "#internal/workflow/runtime.js";

export * from "#execution/durable-session-state.js";

const EVE_SESSION_STREAM_NAMESPACE = "eve.session";

const DURABLE_SESSION_READ_TIMEOUT_MS = 10_000;

/**
 * Reads the latest durable session snapshot and returns the
 * {@link DurableSession} inside.
 *
 * New states carry the snapshot directly through Workflow step
 * results. States without `snapshot` fall back to the legacy
 * `eve.session` stream tail (`startIndex: -1`). The snapshot is
 * migrated to {@link DURABLE_SESSION_VERSION} before return; unknown
 * versions throw.
 *
 * Devalue handles encode/decode so rich types in the session (URL
 * `FilePart.data`, Buffer, Date, Map, Set) round-trip structurally.
 *
 * MUST be called from inside a `"use step"` body.
 */
export async function readDurableSession(state: DurableSessionState): Promise<DurableSession> {
  if (state.snapshot !== undefined) {
    return migrateDurableSessionSnapshot(state.snapshot).session;
  }

  const stream = getRun<unknown>(state.sessionId).getReadable<unknown>({
    namespace: EVE_SESSION_STREAM_NAMESPACE,
    startIndex: -1,
  });
  const reader = stream.getReader();
  let cancelReason = "eve durable session tail read failed";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read().then((read) => ({ kind: "read" as const, read })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), DURABLE_SESSION_READ_TIMEOUT_MS);
      }),
    ]);

    if (result.kind === "timeout") {
      cancelReason = `eve durable session tail read timed out after ${DURABLE_SESSION_READ_TIMEOUT_MS}ms`;
      throw new DurableSessionReadTimeoutError(state);
    }

    if (result.read.done || result.read.value === undefined) {
      cancelReason = "eve durable session tail read returned no snapshot";
      throw new Error(
        `No durable session snapshot found in stream "${EVE_SESSION_STREAM_NAMESPACE}" for run ${state.sessionId}.`,
      );
    }

    cancelReason = "eve durable session tail read complete";
    const snapshot = migrateDurableSessionSnapshot(result.read.value);
    return snapshot.session;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await reader.cancel(cancelReason).catch(() => {});
    reader.releaseLock();
  }
}

class DurableSessionReadTimeoutError extends Error {
  constructor(state: DurableSessionState) {
    super(
      `Timed out reading durable session snapshot from stream "${EVE_SESSION_STREAM_NAMESPACE}" for run ${state.sessionId} after ${DURABLE_SESSION_READ_TIMEOUT_MS}ms.`,
    );
    this.name = "DurableSessionReadTimeoutError";
  }
}
