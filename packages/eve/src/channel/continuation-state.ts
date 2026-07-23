import type { Runtime } from "#channel/types.js";

/** Builds channel-scoped controls for workflow-owned continuation state. */
export function createSetContinuationStateFn(
  runtime: Runtime,
  channelName: string,
):
  | ((options: {
      readonly active: boolean;
      readonly continuationToken: string;
      readonly key: string;
    }) => Promise<void>)
  | undefined {
  const setContinuationState = runtime.setContinuationState;
  if (setContinuationState === undefined) return undefined;

  return async (options): Promise<void> => {
    await setContinuationState({
      active: options.active,
      continuationToken: `${channelName}:${options.continuationToken}`,
      key: options.key,
    });
  };
}
