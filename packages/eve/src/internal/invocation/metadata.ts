import type { RunInput } from "#channel/types.js";

export const INVOCATION_TOKEN_ATTRIBUTE = "$eve.invocation_token";
export const INVOCATION_MODE_ATTRIBUTE = "$eve.invocation_mode";

export type ExternalInvocationMetadata = NonNullable<RunInput["externalInvocation"]>;

export function buildInvocationAttributes(
  metadata: ExternalInvocationMetadata,
): Readonly<Record<string, string>> {
  return {
    [INVOCATION_MODE_ATTRIBUTE]: metadata.mode,
    [INVOCATION_TOKEN_ATTRIBUTE]: metadata.continuationToken,
  };
}
