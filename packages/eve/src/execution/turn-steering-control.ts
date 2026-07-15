import { createHook } from "#compiled/@workflow/core/index.js";

import type { TurnSteeringPayload } from "#execution/turn-control-protocol.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";

/** Owns the active turn's durable steering inbox and step-boundary signal. */
export interface TurnSteeringControl {
  readonly requested: Promise<TurnSteeringPayload>;
  readonly signal: AbortSignal;
  readonly token: string;
  accept(options?: { readonly rearm?: boolean }): Promise<TurnSteeringPayload>;
  dispose(): Promise<void>;
}

/** Creates the private, single-flight steering inbox for one active turn. */
export async function createTurnSteeringControl(token: string): Promise<TurnSteeringControl> {
  const hook = createHook<TurnSteeringPayload>({ token });
  const iterator = hook[Symbol.asyncIterator]();
  await claimHookOwnership(hook);

  let controller: AbortController;
  let requested: Promise<TurnSteeringPayload>;
  let disposed = false;

  const arm = (): void => {
    controller = new AbortController();
    requested = iterator.next().then((next) => {
      if (next.done) return new Promise<never>(() => {});
      controller.abort();
      return next.value;
    });
    requested.catch(() => {});
  };
  arm();

  return {
    get requested() {
      return requested;
    },
    get signal() {
      return controller.signal;
    },
    token: hook.token,
    async accept(options) {
      const value = await requested;
      if (options?.rearm !== false) arm();
      return value;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await disposeHook(hook);
    },
  };
}
