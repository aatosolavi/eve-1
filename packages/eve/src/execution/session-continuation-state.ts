import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import type { ContinuationStateHookPayload, HookPayload } from "#channel/types.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";

/** Derives the durable hook token for one continuation-state key. */
export function continuationStateToken(continuationToken: string, key: string): string {
  if (!key || key.includes(":")) {
    throw new Error("Continuation state keys must be non-empty and cannot contain colons.");
  }
  return `${continuationToken}:${key}`;
}

/** Owns the marker hooks that expose one session's continuation state. */
export interface SessionContinuationState {
  apply(payload: ContinuationStateHookPayload): Promise<void>;
  dispose(): Promise<void>;
}

/** Creates the workflow-owned continuation-state manager for a session. */
export function createSessionContinuationState(): SessionContinuationState {
  const markers = new Map<string, Hook<HookPayload>>();

  return {
    async apply(payload): Promise<void> {
      const token = continuationStateToken(payload.continuationToken, payload.key);
      const existing = markers.get(token);
      if (!payload.active) {
        if (existing !== undefined) {
          await disposeHook(existing);
          markers.delete(token);
        }
        return;
      }
      if (existing !== undefined) return;

      const marker = createHook<HookPayload>({ token });
      await claimHookOwnership(marker);
      markers.set(token, marker);
    },

    async dispose(): Promise<void> {
      await Promise.all([...markers.values()].map((marker) => disposeHook(marker)));
      markers.clear();
    },
  };
}
