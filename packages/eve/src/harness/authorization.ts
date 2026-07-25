import { loadContext } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { createEveConnectionCallbackRoutePath } from "#protocol/routes.js";
import {
  authHookToken,
  CallbackBaseUrlKey,
  PendingAuthorizationResultKey,
  type AuthorizationResult,
} from "#core/authorization.js";

/**
 * The ambient-context half of the authorization API: authoring helpers
 * that read the active runtime context. The signal, state, and predicate
 * half lives in `core/authorization.ts` and is re-exported here.
 */
export * from "#core/authorization.js";

/**
 * Reads the authorization callback on resume. Returns `undefined` if
 * not resuming from an authorization request.
 *
 * When `name` is omitted, returns the first result (convenience for
 * single-challenge tools).
 */
export function getAuthorizationResult(name?: string): AuthorizationResult | undefined {
  const results = loadContext().get(PendingAuthorizationResultKey);
  if (!results || results.length === 0) return undefined;
  if (name === undefined) return results[0];
  return results.find((r) => r.name === name);
}

/**
 * Builds a callback URL for external systems. `name` identifies the
 * callback in the URL path (e.g. a connection name or custom label).
 *
 * The URL embeds a per-authorization hook token derived from the
 * session ID and name (`${sessionId}:auth:${name}`). This token is
 * independent of the continuation token, so channel re-keying
 * mid-turn does not invalidate the callback URL.
 *
 * Returns `undefined` if the session context isn't available.
 */
export function getHookUrl(name: string): string | undefined {
  const ctx = loadContext();
  const sessionId = ctx.get(SessionIdKey);
  const baseUrl = ctx.get(CallbackBaseUrlKey);
  if (!sessionId || !baseUrl) return undefined;
  const token = authHookToken(sessionId);
  return `${baseUrl}${createEveConnectionCallbackRoutePath(name, token)}`;
}
