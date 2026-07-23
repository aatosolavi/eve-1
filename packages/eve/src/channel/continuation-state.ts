import type { Runtime } from "#channel/types.js";

/** Builds channel-scoped controls for workflow-owned continuation state. */
export function createSetContinuationStateFn(runtime: Runtime, channelName: string) {
  return async (options: {
    readonly active: boolean;
    readonly continuationToken: string;
    readonly key: string;
  }): Promise<void> => {
    await runtime.setContinuationState({
      active: options.active,
      continuationToken: `${channelName}:${options.continuationToken}`,
      key: options.key,
    });
  };
}
