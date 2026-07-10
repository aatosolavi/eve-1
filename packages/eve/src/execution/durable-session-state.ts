/**
 * Durable session wire state and pure projections.
 *
 * Session-mutating operations return the current snapshot inside
 * {@link DurableSessionState}; runtime result persistence is the atomic
 * boundary for session program memory. Both {@link DurableSessionState}
 * and {@link DurableSessionSnapshot} carry a `version` so a long-lived
 * session program can ferry shapes written by newer operations. Adding
 * optional fields is forward-compatible (devalue preserves unknown POJO
 * fields); shape-breaking changes bump `version` and add a migrator.
 */
import type { ModelMessage } from "ai";

import { getHarnessEmissionState, type HarnessEmissionState } from "#harness/emission.js";
import { hasProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { projectToDurableSession } from "#execution/session.js";
import type { SandboxState } from "#sandbox/state.js";
import type { JsonObject } from "#shared/json.js";

/** Current wire version for {@link DurableSessionState} and {@link DurableSessionSnapshot}. */
export const DURABLE_SESSION_VERSION = 1;

/**
 * Serializable handle to a durable session.
 *
 * Carries the current session snapshot plus the small projections the
 * runtime program needs without taking an operation boundary: identity,
 * the hook continuation token,
 * `hasProxyInputRequests` (a closed-contract short-circuit that lets
 * the driver skip a per-delivery proxy-routing operation when no
 * descendant subagent is active), and `emissionState` (so runtime-program
 * framework operations can stamp protocol events
 * with `{ turnId, sequence, stepIndex }` without reading the full
 * durable session). All other control-plane state travels via
 * {@link import("#execution/next-driver-action.js").NextDriverAction}.
 * `snapshot` is optional so old stream-backed states can still read
 * from the legacy `eve.session` fallback.
 */
export interface DurableSessionState {
  readonly version: typeof DURABLE_SESSION_VERSION;
  readonly sessionId: string;
  readonly continuationToken: string;
  readonly hasProxyInputRequests: boolean;
  readonly emissionState: HarnessEmissionState;
  readonly snapshot?: DurableSessionSnapshot;
}

/**
 * Durable projection of {@link HarnessSession} embedded in state
 * snapshots or legacy `eve.session` stream chunks.
 *
 * Omits `agent.modelReference`, `agent.tools`,
 * `agent.compactionModelReference`, and the `compaction` thresholds.
 * The runtime rebuilds those every turn from `bundle.turnAgent` through
 * {@link import("#execution/session.js").hydrateDurableSession}.
 * `agent.system` is the last applied prompt snapshot. Before each model step,
 * the execution layer replaces it from the current deployment's
 * `bundle.turnAgent`.
 */
export interface DurableSession {
  readonly sessionId: string;
  /**
   * Top user-facing session id in the dispatch chain. Optional because
   * a top-level session is its own root. Persisted so a rehydrated
   * subagent session still knows its root after a runtime operation
   * boundary.
   */
  readonly rootSessionId?: string;
  readonly continuationToken: string;
  readonly history: ModelMessage[];
  readonly limits?: HarnessSession["limits"];
  readonly outputSchema?: JsonObject;
  readonly state?: SessionStateMap;
  readonly sandboxState?: SandboxState;
  readonly subagentDepth?: number;
  readonly subagentMaxDepth?: number;
  readonly agent: {
    readonly system: string;
  };
  readonly compaction?: {
    readonly lastKnownInputTokens?: number;
    readonly lastKnownPromptMessageCount?: number;
  };
}

/** Versioned wrapper around a {@link DurableSession} on the wire. */
export interface DurableSessionSnapshot {
  readonly version: typeof DURABLE_SESSION_VERSION;
  readonly session: DurableSession;
}

/** Projects a {@link HarnessSession} into the boundary-safe state value. */
export function projectSessionState(input: {
  readonly session: HarnessSession;
}): DurableSessionState {
  return {
    continuationToken: input.session.continuationToken,
    emissionState: getHarnessEmissionState(input.session.state),
    hasProxyInputRequests: hasProxyInputRequests(input.session.state),
    sessionId: input.session.sessionId,
    version: DURABLE_SESSION_VERSION,
  };
}

/**
 * Creates the projected {@link DurableSessionState} with the current
 * snapshot embedded in the runtime operation result.
 */
export function createDurableSessionState(input: {
  readonly session: HarnessSession;
}): DurableSessionState {
  const snapshot: DurableSessionSnapshot = {
    session: projectToDurableSession(input.session),
    version: DURABLE_SESSION_VERSION,
  };

  return {
    ...projectSessionState({ session: input.session }),
    snapshot,
  };
}
