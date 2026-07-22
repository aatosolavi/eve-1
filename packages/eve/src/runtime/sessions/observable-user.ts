import type { SessionAuthContext } from "#channel/types.js";

/** User identity safe for framework-owned observability projections. */
export interface ObservableUserIdentity {
  readonly id: string;
}

/**
 * Projects authenticated user identity without exposing arbitrary auth claims
 * or attributes. Non-user principals are intentionally omitted.
 */
export function toObservableUserIdentity(
  auth: SessionAuthContext | null | undefined,
): ObservableUserIdentity | undefined {
  if (auth?.principalType !== "user" || auth.principalId.length === 0) {
    return undefined;
  }

  return { id: auth.principalId };
}
