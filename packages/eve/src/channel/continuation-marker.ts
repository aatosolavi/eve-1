import type { Runtime } from "#channel/types.js";

/** Builds channel-scoped controls for workflow-owned continuation markers. */
export function createSetContinuationMarkerFn(runtime: Runtime, channelName: string) {
  return async (options: {
    readonly active: boolean;
    readonly continuationToken: string;
    readonly markerToken: string;
  }): Promise<void> => {
    if (runtime.setContinuationMarker === undefined) {
      throw new Error("The active runtime does not support continuation markers.");
    }
    await runtime.setContinuationMarker({
      active: options.active,
      continuationToken: `${channelName}:${options.continuationToken}`,
      markerToken: `${channelName}:${options.markerToken}`,
    });
  };
}
