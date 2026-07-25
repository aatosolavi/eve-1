import {
  EVE_SESSION_STREAM_NAMESPACE,
  readDurableSession as readDurableSessionWith,
  type DurableSession,
  type DurableSessionState,
} from "#core/durable-session-store.js";
import { getRun } from "#internal/workflow/runtime.js";

/**
 * The engine-bound durable session store: the store itself (snapshot
 * decode, migration, the legacy-tail race) is core; this service supplies
 * the one host capability — reading the legacy `eve.session` stream tail
 * through the Workflow runtime — for states persisted before
 * snapshot-carrying step results.
 */

/** Reads the durable session with the Workflow legacy-tail fallback. */
export async function readDurableSession(state: DurableSessionState): Promise<DurableSession> {
  return await readDurableSessionWith(state, {
    readLegacyTail: (sessionId) =>
      getRun<unknown>(sessionId).getReadable<unknown>({
        namespace: EVE_SESSION_STREAM_NAMESPACE,
        startIndex: -1,
      }),
  });
}
