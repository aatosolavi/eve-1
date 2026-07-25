import { describe, expect, it } from "vitest";

import { mcpChannel, withMcpAuth } from "#public/channels/mcp.js";

describe("mcpChannel", () => {
  it("keeps transport separate from auth and metadata", () => {
    const channel = mcpChannel({ agent: { description: "Investigates tasks." } });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /mcp",
      "POST /mcp",
      "DELETE /mcp",
    ]);
  });

  it("adds optional metadata and a standards-compliant 401 challenge", async () => {
    const channel = withMcpAuth(
      mcpChannel({ agent: { description: "Investigates tasks." } }),
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
      mcpChannel({ agent: { description: "Investigates tasks." } }),
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
