import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import type { SessionAuthContext } from "#channel/types.js";
import type { HttpRouteDefinition, RouteDefinition } from "#channel/routes.js";
import {
  createMcpAuthErrorResponse,
  createMcpProtectedResourceMetadata,
} from "#internal/mcp/protected-resource.js";
import { GET, type Channel } from "#public/definitions/channel.js";

const MCP_SESSION_AUTH = Symbol.for("eve.mcp.sessionAuth");

type AuthenticatedMcpRequest = Request & {
  [MCP_SESSION_AUTH]?: SessionAuthContext;
};

export type { AuthInfo };
export type McpTokenVerifier = (
  request: Request,
  bearerToken?: string,
) => AuthInfo | undefined | Promise<AuthInfo | undefined>;

export interface McpProtectedResource {
  readonly authorizationServers: readonly string[];
  /**
   * Canonical public MCP resource URL. Defaults to the request origin plus
   * the channel path. Set this when a gateway fronts a private eve origin.
   */
  readonly resource?: string;
  /** Protected-resource metadata route. */
  readonly metadataPath?: string;
  /** Defaults to the bearer strategy's required scopes. */
  readonly scopesSupported?: readonly string[];
}

export interface McpBearerAuth {
  readonly kind: "bearer";
  readonly protectedResource: McpProtectedResource;
  readonly requiredScopes?: readonly string[];
  /**
   * Provider-specific identity projection. The default never persists the
   * bearer token and uses `extra.sub`/`extra.subject`/`clientId` as identity.
   */
  readonly toSessionAuth?: (
    authInfo: AuthInfo,
    request: Request,
  ) => SessionAuthContext | Promise<SessionAuthContext>;
  /**
   * Portable MCP verifier compatible with `mcp-handler`'s `withMcpAuth`.
   * Signed gateway identity must be cryptographically verified here.
   */
  readonly verifyToken: McpTokenVerifier;
}

export interface McpPublicAuth {
  readonly kind: "public";
}

/** Authentication strategy consumed by {@link mcpChannel}. */
export type McpAuth = McpBearerAuth | McpPublicAuth;

export interface McpBearerAuthOptions {
  readonly protectedResource: McpProtectedResource;
  readonly requiredScopes?: readonly string[];
  readonly toSessionAuth?: McpBearerAuth["toSessionAuth"];
}

/**
 * Creates a fail-closed MCP bearer strategy.
 *
 * Verification remains provider-owned. eve extracts the bearer credential,
 * enforces expiry and scopes, emits protocol challenges, and projects verified
 * identity into the durable session.
 */
export function bearerAuth(
  verifyToken: McpTokenVerifier,
  options: McpBearerAuthOptions,
): McpBearerAuth {
  return {
    kind: "bearer",
    protectedResource: options.protectedResource,
    verifyToken,
    ...(options.requiredScopes === undefined ? {} : { requiredScopes: options.requiredScopes }),
    ...(options.toSessionAuth === undefined ? {} : { toSessionAuth: options.toSessionAuth }),
  };
}

/** Explicitly publishes an MCP channel without authentication. */
export function publicMcpAuth(): McpPublicAuth {
  return { kind: "public" };
}

export function applyMcpAuth<TChannel extends Channel>(
  channel: TChannel,
  auth: McpAuth,
  resourcePath: string,
): TChannel {
  if (auth.kind === "public") return channel;

  const metadataPath =
    auth.protectedResource.metadataPath ?? "/.well-known/oauth-protected-resource";
  const routes: RouteDefinition[] = channel.routes.map((route) => {
    if (route.transport === "websocket") return route;
    return {
      ...route,
      handler: async (request, args) => {
        const resourceMetadataUrl = resolveResourceMetadataUrl(
          request,
          auth.protectedResource.resource,
          metadataPath,
        );
        const bearerToken = extractBearerToken(request.headers.get("authorization"));

        let authInfo: AuthInfo | undefined;
        try {
          authInfo = await auth.verifyToken(request, bearerToken);
        } catch {
          return invalidToken("Invalid token.", resourceMetadataUrl);
        }

        if (authInfo === undefined) {
          return invalidToken("No authorization provided.", resourceMetadataUrl);
        }

        if (authInfo.expiresAt !== undefined && authInfo.expiresAt < Date.now() / 1_000) {
          return invalidToken("Token has expired.", resourceMetadataUrl);
        }

        const missingScopes = (auth.requiredScopes ?? []).filter(
          (scope) => !authInfo.scopes.includes(scope),
        );
        if (missingScopes.length > 0) {
          return createMcpAuthErrorResponse({
            code: "insufficient_scope",
            message: "Insufficient scope.",
            requiredScopes: auth.requiredScopes,
            resourceMetadataUrl,
            status: 403,
          });
        }

        const sessionAuth = await (auth.toSessionAuth?.(authInfo, request) ??
          defaultMcpSessionAuth(authInfo));
        Object.defineProperty(request as AuthenticatedMcpRequest, MCP_SESSION_AUTH, {
          configurable: true,
          enumerable: false,
          value: sessionAuth,
        });
        return await route.handler(request, args);
      },
    } satisfies HttpRouteDefinition;
  });

  routes.unshift(
    mcpProtectedResourceMetadataRoute(auth.protectedResource, resourcePath, auth.requiredScopes),
  );

  return { ...channel, routes } as TChannel;
}

function mcpProtectedResourceMetadataRoute(
  options: McpProtectedResource,
  resourcePath: string,
  requiredScopes: readonly string[] | undefined,
): HttpRouteDefinition {
  const path = options.metadataPath ?? "/.well-known/oauth-protected-resource";
  return GET(path, async (request) => {
    const resource =
      options.resource ?? new URL(resourcePath, new URL(request.url).origin).toString();
    return Response.json(
      createMcpProtectedResourceMetadata({
        authorizationServers: options.authorizationServers,
        resource,
        scopesSupported: options.scopesSupported ?? requiredScopes,
      }),
      { headers: { "cache-control": "no-store" } },
    );
  });
}

export function readMcpSessionAuth(request: Request): SessionAuthContext | null {
  return (request as AuthenticatedMcpRequest)[MCP_SESSION_AUTH] ?? null;
}

function invalidToken(message: string, resourceMetadataUrl: string): Response {
  return createMcpAuthErrorResponse({
    code: "invalid_token",
    message,
    resourceMetadataUrl,
    status: 401,
  });
}

function extractBearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer[ \t]+([^ \t,]+)[ \t]*$/i.exec(header);
  return match?.[1];
}

function resolveResourceMetadataUrl(
  request: Request,
  resource: string | undefined,
  path: string,
): string {
  return new URL(path, resource ?? new URL(request.url).origin).toString();
}

function defaultMcpSessionAuth(authInfo: AuthInfo): SessionAuthContext {
  const extra = authInfo.extra ?? {};
  const subject =
    firstString(extra.sub, extra.subject, extra.userId, extra.principalId) ?? authInfo.clientId;
  const attributes: Record<string, string | readonly string[]> = {
    clientId: authInfo.clientId,
    scopes: [...authInfo.scopes],
  };
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === "string" || isStringArray(value)) attributes[key] = value;
  }

  return {
    attributes,
    authenticator: "mcp",
    issuer: firstString(extra.iss, extra.issuer),
    principalId: subject,
    principalType: firstString(extra.principalType) ?? "oauth-client",
    subject,
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
