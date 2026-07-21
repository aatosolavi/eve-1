import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { SessionAuthContext } from "#channel/types.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createMcpInvocationTools } from "#internal/mcp/invocation-tools.js";
import {
  createMcpAuthChallenge,
  createMcpProtectedResourceMetadata,
} from "#internal/mcp/protected-resource.js";
import {
  createMcpStreamableHttpServer,
  MCP_PROTOCOL_VERSION,
} from "#internal/mcp/streamable-http-server.js";
import { readAgentInvocationService } from "#internal/nitro/routes/channel-route-context.js";
import type { AuthFn } from "#public/channels/auth.js";
import { routeAuth } from "#public/channels/auth.js";
import { defineChannel, DELETE, GET, POST, type Channel } from "#public/definitions/channel.js";
import type { JsonObject } from "#shared/json.js";
import { serializeOutputSchema } from "#shared/tool-schema.js";

const DEFAULT_MCP_ROUTE = "/mcp";
const PROTECTED_RESOURCE_ROUTE_PREFIX = "/.well-known/oauth-protected-resource";
const MCP_SERVER_INFO = { name: "eve", version: resolveInstalledPackageInfo().version };

/** OAuth protected-resource discovery configuration for {@link mcpChannel}. */
export interface McpOAuthConfig {
  readonly authorizationServers: readonly string[];
  /** Canonical public MCP resource URL. Normally derived from the incoming request. */
  readonly resource?: string;
}

/** Configuration for {@link mcpChannel}. */
export interface McpChannelConfig {
  /** Authentication strategies tried in order for every MCP request. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Model-facing description prepended to the `agent_start` tool. */
  readonly description: string;
  /** OAuth discovery metadata for clients that need to obtain credentials. */
  readonly oauth?: McpOAuthConfig;
  /** Fixed output schema enforced for every invocation. Clients cannot override it. */
  readonly outputSchema?: StandardJSONSchemaV1 | JsonObject;
  /** Streamable HTTP endpoint. Defaults to `/mcp`. */
  readonly route?: string;
}

/** Concrete channel returned by {@link mcpChannel}. */
export interface McpChannel extends Channel<
  Record<string, never>,
  Record<string, unknown>,
  McpMetadata
> {}

/**
 * Publishes this agent as a protected, stateless Streamable HTTP MCP server.
 * The channel name is derived from the containing file, like every eve channel.
 */
export function mcpChannel(config: McpChannelConfig): McpChannel {
  const route = requireRoutePath(config.route ?? DEFAULT_MCP_ROUTE, "route");
  const auth = asAuthList(config.auth);
  if (auth.length === 0) throw new Error("mcpChannel auth cannot be empty.");

  const oauth = config.oauth === undefined ? undefined : normalizeOAuthConfig(config.oauth, route);
  const metadataRoute = `${PROTECTED_RESOURCE_ROUTE_PREFIX}${route === "/" ? "" : route}`;
  const outputSchema = serializeOutputSchema(config.outputSchema);
  const resolveProtectedResource = (request: Request) => {
    if (oauth === undefined) return undefined;
    return {
      authorizationServers: oauth.authorizationServers,
      resource: oauth.resource ?? new URL(route, request.url).toString(),
    };
  };
  const authenticate = async (request: Request) => {
    const result = await routeAuth(request, auth);
    if (!(result instanceof Response) || result.status !== 401) return result;
    const protectedResource = resolveProtectedResource(request);
    if (protectedResource === undefined) return result;
    const resourceMetadataUrl = new URL(metadataRoute, protectedResource.resource).toString();
    return createMcpAuthChallenge(resourceMetadataUrl);
  };
  const routes: ReturnType<typeof GET<Record<string, never>>>[] = [];
  if (oauth !== undefined) {
    routes.push(
      GET<Record<string, never>>(metadataRoute, async (request) =>
        Response.json(createMcpProtectedResourceMetadata(resolveProtectedResource(request)!), {
          headers: { "cache-control": "no-store" },
        }),
      ),
    );
  }
  const handle = (request: Request, args: RouteHandlerArgs<Record<string, never>>) =>
    handleMcpRequest(request, args, authenticate, {
      description: config.description,
      outputSchema,
    });
  routes.push(
    GET<Record<string, never>>(route, handle),
    POST<Record<string, never>>(route, handle),
    DELETE<Record<string, never>>(route, handle),
  );

  return defineChannel<Record<string, never>, void, Record<string, unknown>, McpMetadata>({
    kindHint: "mcp",
    state: {},
    metadata: () => ({
      protocolVersion: MCP_PROTOCOL_VERSION,
      route,
      transport: "streamable-http",
    }),
    routes,
  });
}

/** Instrumentation metadata projected for MCP-started sessions. */
export interface McpMetadata extends Record<string, unknown> {
  readonly protocolVersion: string;
  readonly route: string;
  readonly transport: "streamable-http";
}

async function handleMcpRequest(
  request: Request,
  args: RouteHandlerArgs<Record<string, never>>,
  authenticate: (request: Request) => Promise<SessionAuthContext | Response>,
  config: { readonly description: string; readonly outputSchema?: JsonObject },
): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const invocationService = readAgentInvocationService(args);
  if (invocationService === undefined) {
    return Response.json({ error: "MCP requires invocation support." }, { status: 500 });
  }
  return await createMcpStreamableHttpServer({
    authenticate: async () => auth,
    ...MCP_SERVER_INFO,
    tools: createMcpInvocationTools((auth) => invocationService.forCaller(auth), config),
  })(request);
}

function asAuthList(auth: McpChannelConfig["auth"]): readonly AuthFn<Request>[] {
  return Array.isArray(auth) ? (auth as readonly AuthFn<Request>[]) : [auth as AuthFn<Request>];
}

function normalizeOAuthConfig(config: McpOAuthConfig, route: string): McpOAuthConfig {
  const authorizationServers = [...new Set(config.authorizationServers)];
  if (authorizationServers.length === 0) {
    throw new Error("mcpChannel oauth.authorizationServers cannot be empty.");
  }
  for (const authorizationServer of authorizationServers) {
    validateAbsoluteHttpUrl(authorizationServer, "oauth.authorizationServers");
  }
  return {
    authorizationServers,
    resource:
      config.resource === undefined ? undefined : validateResourceUrl(config.resource, route),
  };
}

function validateResourceUrl(resource: string, route: string): string {
  const url = validateAbsoluteHttpUrl(resource, "oauth.resource");
  if (url.pathname !== route) {
    throw new Error(
      `mcpChannel oauth.resource pathname (${JSON.stringify(url.pathname)}) must match route (${JSON.stringify(route)}).`,
    );
  }
  return resource;
}

function validateAbsoluteHttpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`mcpChannel ${field} must contain absolute HTTP(S) URLs.`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`mcpChannel ${field} must contain canonical absolute HTTP(S) URLs.`);
  }
  return url;
}

function requireRoutePath(value: string, field: string): string {
  const base = new URL("https://eve.invalid/");
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    throw invalidRoutePath(field);
  }
  if (
    resolved.origin !== base.origin ||
    resolved.pathname !== value ||
    resolved.search !== "" ||
    resolved.hash !== ""
  ) {
    throw invalidRoutePath(field);
  }
  return value;
}

function invalidRoutePath(field: string): Error {
  return new Error(`mcpChannel ${field} must be an absolute URL pathname.`);
}
