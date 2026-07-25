import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  applyMcpAuth,
  readMcpSessionAuth,
  type AuthInfo,
  type McpAuth,
} from "#public/channels/mcp-auth.js";
import { defineChannel, POST } from "#public/definitions/channel.js";

describe("MCP auth strategy", () => {
  it("passes the portable verifier result through custom session projection", async () => {
    const authInfo: AuthInfo = {
      clientId: "gateway",
      extra: { sub: "user-1" },
      scopes: ["agent:invoke"],
      token: "signed-identity",
    };
    const sessionAuth: SessionAuthContext = {
      attributes: { source: "gateway" },
      authenticator: "signed-gateway",
      principalId: "user-1",
      principalType: "user",
    };
    const verifyToken = vi.fn(async () => authInfo);
    const toSessionAuth = vi.fn(async () => sessionAuth);
    const auth: McpAuth = {
      kind: "bearer",
      protectedResource: {
        authorizationServers: ["https://gateway.example"],
        resource: "https://agent.example/mcp",
      },
      requiredScopes: ["agent:invoke"],
      toSessionAuth,
      verifyToken,
    };
    const channel = applyMcpAuth(
      defineChannel({
        routes: [POST("/mcp", async (request) => Response.json(readMcpSessionAuth(request)))],
      }),
      auth,
      "/mcp",
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

    expect(verifyToken).toHaveBeenCalledWith(expect.any(Request), "signed-identity");
    expect(toSessionAuth).toHaveBeenCalledWith(authInfo, expect.any(Request));
    await expect(response.json()).resolves.toEqual(sessionAuth);
  });
});
