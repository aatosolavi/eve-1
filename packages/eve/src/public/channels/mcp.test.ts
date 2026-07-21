import { describe, expect, it } from "vitest";

import { ForbiddenError, localDev } from "#public/channels/auth.js";
import { mcpChannel } from "#public/channels/mcp.js";

const oauth = {
  authorizationServers: ["https://issuer.example"],
};

describe("mcpChannel", () => {
  it("keeps configuration without OAuth discovery minimal", async () => {
    const channel = mcpChannel({
      auth: localDev(),
      description: "Investigates tasks.",
    });

    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /mcp",
      "POST /mcp",
      "DELETE /mcp",
    ]);

    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      new Request("https://agent.example/mcp", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
        method: "POST",
      }),
      {} as never,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("derives protected-resource metadata from the request URL", async () => {
    const channel = mcpChannel({
      auth: localDev(),
      description: "Investigates tasks.",
      oauth,
    });

    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/oauth-protected-resource/mcp",
      "GET /mcp",
      "POST /mcp",
      "DELETE /mcp",
    ]);
    const route = channel.routes[0]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      new Request("https://agent.example/.well-known/oauth-protected-resource/mcp"),
      {} as never,
    );
    expect(await response.json()).toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/mcp",
    });
  });

  it("derives protected-resource metadata from a custom endpoint", () => {
    const custom = mcpChannel({
      auth: localDev(),
      description: "Investigates tasks.",
      oauth: {
        ...oauth,
        resource: "https://agent.example/agents/research/mcp",
      },
      route: "/agents/research/mcp",
    });

    expect(custom.routes.map((route) => route.path)).toEqual([
      "/.well-known/oauth-protected-resource/agents/research/mcp",
      "/agents/research/mcp",
      "/agents/research/mcp",
      "/agents/research/mcp",
    ]);
  });

  it("rejects a resource URL that does not identify the configured route", () => {
    expect(() =>
      mcpChannel({
        auth: localDev(),
        description: "Investigates tasks.",
        oauth: { ...oauth, resource: "https://agent.example/other" },
      }),
    ).toThrow("must match route");
  });

  it("requires canonical authorization server URLs", () => {
    expect(() =>
      mcpChannel({
        auth: localDev(),
        description: "Investigates tasks.",
        oauth: { authorizationServers: [] },
      }),
    ).toThrow("cannot be empty");
    expect(() =>
      mcpChannel({
        auth: localDev(),
        description: "Investigates tasks.",
        oauth: { authorizationServers: ["issuer.example"] },
      }),
    ).toThrow("absolute HTTP(S) URLs");
    expect(() =>
      mcpChannel({
        auth: localDev(),
        description: "Investigates tasks.",
        oauth: { authorizationServers: ["https://issuer.example?tenant=one"] },
      }),
    ).toThrow("canonical absolute HTTP(S) URLs");
  });

  it("deduplicates authorization servers", async () => {
    const channel = mcpChannel({
      auth: localDev(),
      description: "Investigates tasks.",
      oauth: {
        authorizationServers: ["https://issuer.example", "https://issuer.example"],
      },
    });
    const route = channel.routes[0]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      new Request("https://agent.example/.well-known/oauth-protected-resource/mcp"),
      {} as never,
    );
    await expect(response.json()).resolves.toMatchObject({
      authorization_servers: ["https://issuer.example"],
    });
  });

  it.each([
    "mcp",
    "//attacker.example/mcp",
    "/\\\\attacker.example/mcp",
    "/agents/../mcp",
    "/mcp?tenant=a",
    "/mcp#fragment",
  ])("rejects a route that is not a canonical absolute pathname: %s", (route) => {
    expect(() =>
      mcpChannel({ auth: localDev(), description: "Investigates tasks.", route }),
    ).toThrow("absolute URL pathname");
  });

  it("preserves explicit authorization failures", async () => {
    const forbidden = mcpChannel({
      auth: async () => {
        throw new ForbiddenError({ message: "Insufficient scope." });
      },
      description: "Investigates tasks.",
    });
    const route = forbidden.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      new Request("https://agent.example/mcp", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
        method: "POST",
      }),
      {} as never,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "forbidden",
      error: "Insufficient scope.",
    });
  });

  it("returns an MCP OAuth discovery challenge before runtime lookup", async () => {
    const channel = mcpChannel({
      auth: async () => null,
      description: "Investigates tasks.",
      oauth,
    });
    const route = channel.routes[2]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      new Request("https://agent.example/mcp", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
        method: "POST",
      }),
      {} as never,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://agent.example/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
