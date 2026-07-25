import { describe, expect, it } from "vitest";

import {
  createMcpAuthErrorResponse,
  createMcpProtectedResourceMetadata,
} from "#internal/mcp/protected-resource.js";

describe("MCP protected-resource authentication", () => {
  it("builds RFC 9728 metadata", () => {
    expect(
      createMcpProtectedResourceMetadata({
        authorizationServers: ["https://issuer.example"],
        resource: "https://agent.example/mcp",
        scopesSupported: ["agent:invoke"],
      }),
    ).toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/mcp",
      scopes_supported: ["agent:invoke"],
    });
  });

  it("challenges with the metadata URL", () => {
    const response = createMcpAuthErrorResponse({
      code: "invalid_token",
      message: "No authorization provided.",
      resourceMetadataUrl: "https://agent.example/.well-known/oauth-protected-resource",
      status: 401,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", error_description="No authorization provided.", resource_metadata="https://agent.example/.well-known/oauth-protected-resource"',
    );
  });
});
