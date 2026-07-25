export interface McpProtectedResourceMetadataOptions {
  readonly authorizationServers: readonly string[];
  readonly resource: string;
  readonly scopesSupported?: readonly string[];
}

export interface McpAuthErrorResponseOptions {
  readonly code: "invalid_token" | "insufficient_scope";
  readonly message: string;
  readonly requiredScopes?: readonly string[];
  readonly resourceMetadataUrl: string;
  readonly status: 401 | 403;
}

/** Creates RFC 9728 protected-resource metadata for an MCP endpoint. */
export function createMcpProtectedResourceMetadata(
  options: McpProtectedResourceMetadataOptions,
): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {
    authorization_servers: options.authorizationServers,
    resource: options.resource,
  };
  if (options.scopesSupported !== undefined) {
    metadata.scopes_supported = options.scopesSupported;
  }
  return metadata;
}

/** Creates an RFC 6750/RFC 9728 bearer failure and discovery challenge. */
export function createMcpAuthErrorResponse(options: McpAuthErrorResponseOptions): Response {
  const challenge = [
    `Bearer error="${escapeChallenge(options.code)}"`,
    `error_description="${escapeChallenge(options.message)}"`,
    `resource_metadata="${escapeChallenge(options.resourceMetadataUrl)}"`,
  ];
  if (options.requiredScopes?.length) {
    challenge.push(`scope="${escapeChallenge(options.requiredScopes.join(" "))}"`);
  }
  return Response.json(
    { error: options.code, error_description: options.message },
    {
      headers: {
        "cache-control": "no-store",
        "www-authenticate": challenge.join(", "),
      },
      status: options.status,
    },
  );
}

function escapeChallenge(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
