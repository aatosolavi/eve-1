import { describe, expect, it } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import {
  attachAgentInfoRouteResponse,
  attachRouteAgent,
} from "#internal/nitro/routes/channel-route-context.js";
import { MCP_PROTOCOL_VERSION } from "#internal/mcp/streamable-http-server.js";
import type { Agent } from "#public/definitions/channel.js";
import { mcpChannel, withMcpAuth } from "#public/channels/mcp.js";

describe("mcpChannel", () => {
  it("keeps transport options separate from auth and agent metadata", () => {
    const channel = mcpChannel();
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /mcp",
      "POST /mcp",
      "DELETE /mcp",
    ]);
  });

  it("derives its MCP presentation from compiled root agent metadata", async () => {
    const channel = mcpChannel();
    const postRoute = channel.routes[1]!;
    if (postRoute.transport === "websocket") throw new Error("expected HTTP route");
    const args = attachAgentInfoRouteResponse(
      attachRouteAgent({} as RouteHandlerArgs, {} as Agent),
      async () =>
        Response.json({
          agent: {
            description: "Investigates tasks.",
            name: "compiled-agent",
          },
        }),
    );
    const initialize = await postRoute.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
      }),
      args,
    );
    await expect(initialize.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "compiled-agent" } },
    });

    const tools = await postRoute.handler(
      mcpRequest({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
      args,
    );
    const toolsBody = (await tools.json()) as {
      result: { tools: { description?: string; name: string }[] };
    };
    expect(toolsBody.result.tools.find((tool) => tool.name === "agent_start")).toMatchObject({
      description: expect.stringContaining("Investigates tasks."),
      name: "agent_start",
    });
  });

  it("adds optional metadata and a standards-compliant 401 challenge", async () => {
    const channel = withMcpAuth(
      mcpChannel(),
      async (_request, token) =>
        token === "valid" ? { clientId: "client", scopes: ["agent:invoke"], token } : undefined,
      {
        protectedResourceMetadata: {
          authorizationServers: ["https://issuer.example"],
          resource: "https://agent.example/mcp",
          scopesSupported: ["agent:invoke"],
        },
        required: true,
        requiredScopes: ["agent:invoke"],
        resourceUrl: "https://agent.example",
      },
    );

    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/oauth-protected-resource",
      "GET /mcp",
      "POST /mcp",
      "DELETE /mcp",
    ]);

    const metadataRoute = channel.routes[0]!;
    if (metadataRoute.transport === "websocket") throw new Error("expected HTTP route");
    const metadata = await metadataRoute.handler(
      new Request("https://agent.example/.well-known/oauth-protected-resource"),
      {} as never,
    );
    await expect(metadata.json()).resolves.toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/mcp",
      scopes_supported: ["agent:invoke"],
    });

    const postRoute = channel.routes[2]!;
    if (postRoute.transport === "websocket") throw new Error("expected HTTP route");
    const response = await postRoute.handler(
      new Request("https://private-origin.example/mcp", { method: "POST" }),
      {} as never,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource"',
    );
  });

  it("returns 403 when a valid token lacks required scopes", async () => {
    const channel = withMcpAuth(
      mcpChannel(),
      async (_request, token) =>
        token ? { clientId: "client", scopes: ["profile"], token } : undefined,
      { required: true, requiredScopes: ["agent:invoke"] },
    );
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      new Request("https://agent.example/mcp", {
        headers: { authorization: "Bearer signed-identity" },
        method: "POST",
      }),
      {} as never,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(response.headers.get("www-authenticate")).toContain('scope="agent:invoke"');
  });
});

function mcpRequest(body: unknown): Request {
  return new Request("https://agent.example/mcp", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    method: "POST",
  });
}
