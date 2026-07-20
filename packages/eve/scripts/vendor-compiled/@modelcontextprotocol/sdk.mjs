export default {
  packageName: "@modelcontextprotocol/sdk",
  compiledPath: "@modelcontextprotocol/sdk",
  chunkGroup: "workflow",
  entries: [
    {
      entry: "dist/esm/server/index.js",
      outputPath: "server",
      declaration: `
export interface McpSdkRequest {
  readonly params: Readonly<Record<string, unknown>>;
}

export interface McpRequestHandlerExtra {
  readonly signal: AbortSignal;
}

export declare class Server {
  constructor(info: { readonly name: string; readonly version: string }, options?: {
    readonly capabilities?: Readonly<Record<string, unknown>>;
  });
  connect(transport: WebStandardTransport): Promise<void>;
  close(): Promise<void>;
  setRequestHandler<Request extends McpSdkRequest, Result>(
    schema: McpRequestSchema<Request>,
    handler: (request: Request, extra: McpRequestHandlerExtra) => Result | Promise<Result>,
  ): void;
}

interface McpRequestSchema<Request extends McpSdkRequest> {
  readonly __request?: Request;
}

interface WebStandardTransport {
  handleRequest(request: Request): Promise<Response>;
}
`,
    },
    {
      entry: "dist/esm/server/webStandardStreamableHttp.js",
      outputPath: "web-standard-streamable-http",
      declaration: `
export declare class WebStandardStreamableHTTPServerTransport {
  constructor(options?: {
    readonly enableJsonResponse?: boolean;
    readonly sessionIdGenerator?: undefined;
  });
  handleRequest(request: Request): Promise<Response>;
}
`,
    },
    {
      entry: "dist/esm/types.js",
      outputPath: "types",
      declaration: `
export interface CallToolRequest {
  readonly params: {
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly name: string;
  };
}

export interface ListToolsRequest {
  readonly params: Readonly<Record<string, unknown>>;
}

interface McpRequestSchema<Request> {
  readonly __request?: Request;
}

export declare const CallToolRequestSchema: McpRequestSchema<CallToolRequest>;
export declare const ListToolsRequestSchema: McpRequestSchema<ListToolsRequest>;
`,
    },
  ],
  platform: "neutral",
};
