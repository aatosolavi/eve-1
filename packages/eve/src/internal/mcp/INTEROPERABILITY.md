# MCP Streamable HTTP interoperability spike

This internal spike targets MCP protocol version `2025-06-18`. It uses Streamable HTTP's stateless JSON response mode: the server does not issue `Mcp-Session-Id`, POST notifications receive `202`, and DELETE receives `405` because there is no transport session to terminate.

The implementation vendors the official `@modelcontextprotocol/sdk` as a build-time dependency and uses its web-standard Streamable HTTP transport and low-level server. The vendored surface supports `initialize`, `ping`, `tools/list`, `tools/call`, JSON-RPC errors, protocol validation, and initialization/cancellation notifications without adding an eve runtime dependency. Cancellation of durable agent work is an explicit tool in the public channel; a cancellation notification arriving on another stateless HTTP request cannot reliably abort an earlier request.

## Inspector

Run the public channel locally or deploy it, then use:

```sh
pnpm --filter eve mcp:inspector-smoke https://<host>/mcp
```

In Inspector, select Streamable HTTP, authenticate, initialize, list tools, and call each tool. Disconnect and reconnect before reading an invocation to verify that no transport session owns invocation state.

## Claude Code

Current Claude Code setup is expected to be:

```sh
claude mcp add --transport http eve-demo https://<host>/mcp
claude mcp login eve-demo
claude mcp get eve-demo
```

The endpoint's unauthenticated response is `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` challenge. Claude should fetch that RFC 9728 document, discover the external authorization server, authenticate there, and retry `/mcp` with its bearer token.

Provider requirements vary. The authorization server must support Claude's OAuth client flow, including dynamic client registration, or the Claude configuration must supply an explicit client ID. eve remains only the protected resource and does not issue tokens.

The spike intentionally does not vary tool discovery by experimental MCP Tasks capabilities. The public milestone exposes compatibility tools to ordinary MCP clients; a later adapter can use the SDK's Tasks support to settle extension-specific discovery with clients that implement Tasks.

## Vendored footprint

Using the existing compiled-vendor pipeline, the SDK server, web-standard transport, request schemas, shared chunks, declarations, and license add approximately 256 KB uncompressed and 71 KB gzip across emitted JavaScript files. The source package remains a dev dependency; consumers still install only eve's runtime dependencies.
