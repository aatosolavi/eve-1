import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  createMcpStreamableHttpServer,
  MCP_PROTOCOL_VERSION,
} from "#internal/mcp/streamable-http-server.js";

const auth: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://agent.example/mcp", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

function server() {
  const call = vi.fn(async (input: unknown) => ({
    content: [{ text: JSON.stringify(input), type: "text" as const }],
  }));
  return {
    call,
    handle: createMcpStreamableHttpServer({
      authenticate: async () => auth,
      name: "eve-test",
      tools: [
        {
          call,
          definition: {
            description: "Echoes input.",
            inputSchema: { type: "object" },
            name: "echo",
          },
        },
      ],
      version: "0.0.0",
    }),
  };
}

function initialize(handle: (request: Request) => Promise<Response>): Promise<Response> {
  return handle(
    request({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "eve-test-client", version: "0.0.0" },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    }),
  );
}

describe("stateless MCP Streamable HTTP server", () => {
  it("negotiates initialize and advertises tools", async () => {
    const { handle } = server();
    const initialized = await initialize(handle);
    expect(await initialized.json()).toMatchObject({
      id: 1,
      result: {
        capabilities: { tools: { listChanged: false } },
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: "eve-test", version: "0.0.0" },
      },
    });
    expect(initialized.headers.get("mcp-session-id")).toBeNull();

    const listed = await handle(request({ id: 2, jsonrpc: "2.0", method: "tools/list" }));
    expect(await listed.json()).toMatchObject({ result: { tools: [{ name: "echo" }] } });
  });

  it("calls tools with authenticated context and SDK cancellation", async () => {
    const { call, handle } = server();
    const response = await handle(
      request({
        id: "call-1",
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { value: 42 }, name: "echo" },
      }),
    );
    expect(await response.json()).toMatchObject({
      id: "call-1",
      result: { content: [{ text: '{"value":42}', type: "text" }] },
    });
    expect(call).toHaveBeenCalledWith(
      { value: 42 },
      expect.objectContaining({ auth, signal: expect.any(AbortSignal) }),
    );
  });

  it("returns JSON-RPC errors and acknowledges notifications", async () => {
    const { handle } = server();
    const unknown = await handle(request({ id: 3, jsonrpc: "2.0", method: "unknown" }));
    expect(await unknown.json()).toMatchObject({
      error: { code: -32601, message: "Method not found" },
      id: 3,
      jsonrpc: "2.0",
    });

    const notification = await handle(
      request({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
  });

  it("authenticates before transport handling", async () => {
    const challenge = new Response(null, {
      headers: {
        "www-authenticate":
          'Bearer resource_metadata="https://agent.example/.well-known/oauth-protected-resource"',
      },
      status: 401,
    });
    const handle = createMcpStreamableHttpServer({
      authenticate: async () => challenge,
      name: "test",
      tools: [],
      version: "0",
    });

    const unauthorized = await handle(request("not relevant"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata=");

    const streamed = await handle(new Request("https://agent.example/mcp"));
    expect(streamed.status).toBe(401);

    const deleted = await handle(new Request("https://agent.example/mcp", { method: "DELETE" }));
    expect(deleted.status).toBe(401);
  });

  it("opens the SDK's stateless SSE stream for authenticated GET", async () => {
    const response = await server().handle(
      new Request("https://agent.example/mcp", {
        headers: { accept: "text/event-stream" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await response.body?.cancel();
  });

  it("enforces Streamable HTTP media types", async () => {
    const response = await server().handle(
      request({ id: 1, jsonrpc: "2.0", method: "ping" }, { accept: "application/json" }),
    );

    expect(response.status).toBe(406);
    expect(await response.json()).toMatchObject({ error: { code: -32000 } });
  });

  it("rejects duplicate tool names at construction", () => {
    const tool = {
      call: async () => ({ content: [] }),
      definition: { inputSchema: {}, name: "duplicate" },
    };
    expect(() =>
      createMcpStreamableHttpServer({
        authenticate: async () => auth,
        name: "test",
        tools: [tool, tool],
        version: "0",
      }),
    ).toThrow("MCP tool names must be unique");
  });
});
