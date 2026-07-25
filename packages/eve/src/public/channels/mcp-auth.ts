import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import type { SessionAuthContext } from "#channel/types.js";
import type { HttpRouteDefinition, RouteDefinition } from "#channel/routes.js";
import {
  createMcpAuthErrorResponse,
  createMcpProtectedResourceMetadata,
  type McpProtectedResourceMetadataOptions,
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

export interface McpAuthOptions {
  /** Match `mcp-handler`: anonymous requests pass through unless explicitly required. */
  readonly required?: boolean;
  readonly requiredScopes?: readonly string[];
  readonly resourceMetadataPath?: string;
  /**
   * Public resource origin used to construct the metadata URL. Set this when a
   * gateway terminates auth in front of a private eve deployment.
   */
  readonly resourceUrl?: string;
  /**
   * Optionally add an RFC 9728 protected-resource metadata route to the
   * compiled channel. Authorization-server and token-issuance behavior stays
   * outside eve.
   */
  readonly protectedResourceMetadata?: McpProtectedResourceMetadataOptions;
  /**
   * Provider-specific identity projection. The default never persists the
   * bearer token and uses `extra.sub`/`extra.subject`/`clientId` as identity.
   */
  readonly toSessionAuth?: (
    authInfo: AuthInfo,
    request: Request,
  ) => SessionAuthContext | Promise<SessionAuthContext>;
}

/**
 * Adds portable MCP bearer verification to a compiled channel.
 *
 * The verifier contract is intentionally the same shape as
 * `mcp-handler`'s `withMcpAuth`: provider integrations validate the token and
 * return the standard MCP SDK `AuthInfo`. eve owns only protocol glue, scope
 * enforcement, challenges, and projection into durable session auth.
 */
export function withMcpAuth<TChannel extends Channel>(
  channel: TChannel,
  verifyToken: McpTokenVerifier,
  options: McpAuthOptions = {},
): TChannel {
  const resourceMetadataPath =
    options.resourceMetadataPath ?? "/.well-known/oauth-protected-resource";
  const routes: RouteDefinition[] = channel.routes.map((route) => {
    if (route.transport === "websocket") return route;
    return {
      ...route,
      handler: async (request, args) => {
        const resourceMetadataUrl = resolveResourceMetadataUrl(
          request,
          options.resourceUrl,
          resourceMetadataPath,
        );
        const bearerToken = extractBearerToken(request.headers.get("authorization"));

        let authInfo: AuthInfo | undefined;
        try {
          authInfo = await verifyToken(request, bearerToken);
        } catch {
          return createMcpAuthErrorResponse({
            code: "invalid_token",
            message: "Invalid token.",
            resourceMetadataUrl,
            status: 401,
          });
        }

        if (authInfo === undefined) {
          if (!options.required) return await route.handler(request, args);
          return createMcpAuthErrorResponse({
            code: "invalid_token",
            message: "No authorization provided.",
            resourceMetadataUrl,
            status: 401,
          });
        }

        if (authInfo.expiresAt !== undefined && authInfo.expiresAt < Date.now() / 1_000) {
          return createMcpAuthErrorResponse({
            code: "invalid_token",
            message: "Token has expired.",
            resourceMetadataUrl,
            status: 401,
          });
        }

        const missingScopes = (options.requiredScopes ?? []).filter(
          (scope) => !authInfo.scopes.includes(scope),
        );
        if (missingScopes.length > 0) {
          return createMcpAuthErrorResponse({
            code: "insufficient_scope",
            message: "Insufficient scope.",
            requiredScopes: options.requiredScopes,
            resourceMetadataUrl,
            status: 403,
          });
        }

        const sessionAuth = await (options.toSessionAuth?.(authInfo, request) ??
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

  if (options.protectedResourceMetadata !== undefined) {
    routes.unshift(
      mcpProtectedResourceMetadataRoute(options.protectedResourceMetadata, resourceMetadataPath),
    );
  }

  return { ...channel, routes } as TChannel;
}

/** Builds a public RFC 9728 metadata route without enabling any OAuth provider. */
export function mcpProtectedResourceMetadataRoute(
  options: McpProtectedResourceMetadataOptions,
  path = "/.well-known/oauth-protected-resource",
): HttpRouteDefinition {
  return GET(path, async () =>
    Response.json(createMcpProtectedResourceMetadata(options), {
      headers: { "cache-control": "no-store" },
    }),
  );
}

export function readMcpSessionAuth(request: Request): SessionAuthContext | null {
  return (request as AuthenticatedMcpRequest)[MCP_SESSION_AUTH] ?? null;
}

function extractBearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer[ \t]+([^ \t,]+)[ \t]*$/i.exec(header);
  return match?.[1];
}

function resolveResourceMetadataUrl(
  request: Request,
  resourceUrl: string | undefined,
  path: string,
): string {
  return new URL(path, resourceUrl ?? new URL(request.url).origin).toString();
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
