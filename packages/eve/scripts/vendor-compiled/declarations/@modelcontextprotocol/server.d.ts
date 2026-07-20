export interface McpSdkRequest {
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface McpRequestHandlerExtra {
  readonly signal: AbortSignal;
}

export declare class Server {
  constructor(
    info: { readonly name: string; readonly version: string },
    options?: {
      readonly capabilities?: Readonly<Record<string, unknown>>;
    },
  );
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
