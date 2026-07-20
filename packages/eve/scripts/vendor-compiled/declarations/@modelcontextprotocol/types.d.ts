export interface CallToolRequest {
  readonly params: {
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly name: string;
  };
}

export interface ListToolsRequest {
  readonly params?: Readonly<Record<string, unknown>>;
}

interface McpRequestSchema<Request> {
  readonly __request?: Request;
}

export declare const CallToolRequestSchema: McpRequestSchema<CallToolRequest>;
export declare const ListToolsRequestSchema: McpRequestSchema<ListToolsRequest>;
