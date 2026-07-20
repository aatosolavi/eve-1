export declare class WebStandardStreamableHTTPServerTransport {
  constructor(options?: {
    readonly enableJsonResponse?: boolean;
    readonly sessionIdGenerator?: undefined;
  });
  handleRequest(request: Request): Promise<Response>;
}
