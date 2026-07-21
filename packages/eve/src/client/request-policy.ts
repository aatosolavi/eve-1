import type { ClientCredentialsPolicy, ClientRedirectPolicy } from "#client/types.js";

/** Client-wide fetch policy shared by all requests for one client. */
export interface ClientRequestPolicy {
  readonly credentials?: ClientCredentialsPolicy;
  readonly redirect?: ClientRedirectPolicy;
}

/**
 * Applies client-wide request policy without overriding an explicit per-request
 * credentials mode. Redirect remains enforced so authentication headers cannot
 * follow a redirect that the client configuration forbids.
 */
export function applyClientRequestPolicy(
  init: RequestInit,
  policy: ClientRequestPolicy,
): RequestInit {
  const resolved = { ...init };

  if (resolved.credentials === undefined && policy.credentials !== undefined) {
    resolved.credentials = policy.credentials;
  }

  if (policy.redirect !== undefined) {
    resolved.redirect = policy.redirect;
  }

  return resolved;
}
