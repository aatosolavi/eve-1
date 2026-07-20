import {
  CallToolRequestSchema,
  type CallToolRequest,
  ListToolsRequestSchema,
} from "#compiled/@modelcontextprotocol/sdk/types.js";
import { Server } from "#compiled/@modelcontextprotocol/sdk/server.js";
import { WebStandardStreamableHTTPServerTransport } from "#compiled/@modelcontextprotocol/sdk/web-standard-streamable-http.js";

import type { SessionAuthContext } from "#channel/types.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

/** Stable structured tool failure surfaced to MCP clients. */
export class McpServerToolError extends Error {
  readonly code: string;
  readonly data?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, data?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "McpServerToolError";
    this.code = code;
    this.data = data;
  }
}

export interface McpCallToolResult {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

export type McpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resource_link"; readonly name: string; readonly uri: string };

export interface McpServerTool {
  readonly definition: McpToolDefinition;
  call(
    input: unknown,
    context: { readonly auth: SessionAuthContext; readonly signal: AbortSignal },
  ): Promise<McpCallToolResult>;
}

export interface McpStreamableHttpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpServerTool[];
  authenticate(request: Request): Promise<SessionAuthContext | Response>;
}

/**
 * Creates a stateless MCP Streamable HTTP request handler.
 *
 * Each request gets a fresh SDK server and transport because the transport
 * deliberately does not issue `Mcp-Session-Id` or retain process-local state.
 */
export function createMcpStreamableHttpServer(
  options: McpStreamableHttpServerOptions,
): (request: Request) => Promise<Response> {
  const tools = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  if (tools.size !== options.tools.length) throw new Error("MCP tool names must be unique.");

  return async (request) => {
    const auth = await options.authenticate(request);
    if (auth instanceof Response) return auth;

    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    const server = createServer(options, tools, auth);
    await server.connect(transport);

    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}

function createServer(
  options: Pick<McpStreamableHttpServerOptions, "name" | "version">,
  tools: ReadonlyMap<string, McpServerTool>,
  auth: SessionAuthContext,
): Server {
  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map((tool) => tool.definition),
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => await callTool(request, extra.signal, auth, tools),
  );

  return server;
}

async function callTool(
  request: CallToolRequest,
  signal: AbortSignal,
  auth: SessionAuthContext,
  tools: ReadonlyMap<string, McpServerTool>,
): Promise<McpCallToolResult> {
  const tool = tools.get(request.params.name);
  if (tool === undefined) {
    return toolError(
      new McpServerToolError("unknown_tool", `Unknown tool: ${request.params.name}`),
    );
  }

  try {
    return await tool.call(request.params.arguments ?? {}, { auth, signal });
  } catch (error) {
    return toolError(normalizeToolError(error));
  }
}

function normalizeToolError(error: unknown): McpServerToolError {
  if (error instanceof McpServerToolError) return error;
  return new McpServerToolError("internal_error", "Tool call failed.");
}

function toolError(error: McpServerToolError): McpCallToolResult {
  const value: { code: string; data?: Readonly<Record<string, unknown>>; message: string } = {
    code: error.code,
    message: error.message,
  };
  if (error.data !== undefined) value.data = error.data;
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: true,
    structuredContent: value,
  };
}
