---
issue: https://github.com/vercel/eve/issues/883
status: proposed
last_updated: "2026-07-16"
---

# Native MCP channel

## Summary

Add an opt-in `mcpChannel()` that exposes an eve agent to external agent harnesses through the Model Context Protocol.

The first version exposes only capabilities known when the agent is compiled:

- compiled instructions;
- complete static skill packages;
- statically authored executable tools;
- the same capabilities from recursively nested local subagents.

Remote subagents are never exposed. Dynamic instructions, skills, and tools are excluded, as are framework tools, provider-managed tools, connection-discovered tools, and local subagent delegation tools.

Tool calls execute directly in the owning agent node. They do not create an eve run, invoke a model, dispatch a subagent, or write durable session history. Each call receives a request-scoped eve context populated from the authenticated MCP request and an optional authored `onRequest` projection.

“Static tool” describes how the tool is discovered, not its effects. An exposed tool may still call APIs, use a sandbox, or mutate external systems.

## Protocol target

Target the current stable MCP revision, [`2025-11-25`](https://modelcontextprotocol.io/docs/learn/versioning), using [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

Use the stable official TypeScript SDK v1 line, pinned initially to `@modelcontextprotocol/sdk@1.29.0`. Vendor the required low-level server, schemas, and Web Standard transport through eve’s compiled-dependency system so `nitro` remains the only runtime dependency. Do not build against the draft SDK or draft protocol.

The [current draft changelog](https://modelcontextprotocol.io/specification/draft/changelog) removes protocol-level sessions and makes list results stable across requests. That direction reinforces the request-scoped design, but draft behavior is not part of this version.

The server declares only:

```json
{
  "capabilities": {
    "resources": {},
    "tools": {}
  }
}
```

`prompts`, `logging`, `tasks`, `sampling`, `elicitation`, `completions`, resource subscriptions, and list-changed notifications are not advertised.

The initialization result uses:

- `serverInfo.name: "eve"`;
- `serverInfo.version`: the installed eve package version;
- `serverInfo.title`: the authored root agent name, when configured;
- `instructions`: the root node’s compiled static instructions, when present.

The initialization instructions are not augmented with generated MCP guidance or skill summaries. They preserve eve’s compiled static instruction content exactly.

## Public authoring API

```ts
// agent/channels/mcp.ts
import { localDev, vercelOidc } from "eve/channels/auth";
import { defaultMcpAuth, mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth: [vercelOidc(), localDev()],
  onRequest(ctx) {
    const harnessSessionId = ctx.mcp.request.headers.get("x-harness-session-id");

    if (harnessSessionId === null) return { auth: defaultMcpAuth(ctx) };
    return { auth: defaultMcpAuth(ctx), session: { id: harnessSessionId } };
  },
});
```

Add the public surface:

```ts
export interface McpHandle {
  readonly caller: SessionAuthContext | null;
  readonly request: Request;
}

export interface McpRequestContext {
  readonly mcp: McpHandle;
}

export interface McpRequestSessionInput {
  readonly id?: string;
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly parent?: SessionParent;
  readonly turn?: SessionTurn;
}

export interface McpRequestResult {
  readonly auth: SessionAuthContext | null;
  readonly session?: McpRequestSessionInput;
}

export type McpRequestResultOrPromise = McpRequestResult | Promise<McpRequestResult>;

export interface McpChannelInput {
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  readonly allowedOrigins?: readonly string[];
  readonly onRequest?: (ctx: McpRequestContext) => McpRequestResultOrPromise;
}

export interface McpChannel extends Channel {}

export function defaultMcpAuth(ctx: McpRequestContext): SessionAuthContext | null;
export function mcpChannel(input: McpChannelInput): McpChannel;
```

`mcpChannel()` is exported from `eve/channels/mcp`. It mounts a fixed `/mcp` endpoint.

The channel is explicit opt-in. It is not added to the framework’s default channels, and no MCP route exists unless the application authors `agent/channels/mcp.ts`.

`auth` is required and uses the existing ordered `AuthFn` and `routeAuth` behavior. Authors may explicitly use `none()` for a public server, but the API never defaults to anonymous access.

`onRequest` is optional and runs once for each authenticated, protocol-valid `POST /mcp` request, after Origin and route-auth checks and before method dispatch. Its input exposes the original Web `Request` and the admitted route caller. The default result is equivalent to:

```ts
return { auth: defaultMcpAuth(ctx) };
```

`defaultMcpAuth(ctx)` returns `ctx.mcp.caller` unchanged, matching the default-auth helpers exposed by eve's other channels. A custom hook calls it when it wants to preserve route auth while supplying harness session fields. The returned `auth` becomes `ctx.session.auth.current`; `session.initiatorAuth` defaults to the same value. The optional `session` object can replace every other tool-visible session field: logical id, initiator auth, turn, and parent lineage. The result is scoped to that POST and is never cached by the MCP channel.

Omitted session fields retain the MCP defaults. Invalid ids, turn sequences, or parent values fail the affected MCP request without invoking a tool. A thrown `onRequest` error is logged with a framework error id and returned as a sanitized MCP internal error. The hook cannot bypass route authentication because rejected requests never reach it. Static resource and list handlers do not otherwise use the projected session data.

`allowedOrigins` contains additional exact browser origins. Each value must be an absolute origin without credentials, path, query, or fragment. Wildcards and opaque `"null"` origins are rejected when the channel is created.

When `allowedOrigins` is omitted:

- requests without `Origin` are accepted for non-browser MCP clients;
- same-origin browser requests are accepted;
- all cross-origin and opaque-origin requests receive `403`.

Configured cross-origin requests receive exact reflected CORS headers and `Vary: Origin`. Preflight permits `POST` and the MCP, authorization, accept, and content-type request headers.

## Static capability projection

### Agent namespace

The root agent has no tool-name prefix. Every local subagent directory adds one dot-separated segment:

| Agent node            | Resource prefix                          | Tool prefix            |
| --------------------- | ---------------------------------------- | ---------------------- |
| Root                  | `eve://agents/root/`                     | none                   |
| `researcher`          | `eve://agents/root/researcher/`          | `researcher.`          |
| `researcher/reviewer` | `eve://agents/root/researcher/reviewer/` | `researcher.reviewer.` |

Traversal follows only runtime subagent-registry entries whose `kind` is `"subagent"`. Entries whose kind is `"remote"` are neither traversed nor listed. Their names, descriptions, schemas, and URLs must not leak through MCP.

The final MCP tool name must be unique, between 1 and 128 characters, and contain only ASCII letters, digits, `_`, `-`, and `.` as recommended by the [MCP tool-name rules](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Names are never silently sanitized. A collision or invalid final name fails MCP capability construction with both source paths in the diagnostic.

### Instructions

Expose one resource for each local node with compiled static instructions:

```text
eve://agents/root/instructions.md
eve://agents/root/researcher/instructions.md
eve://agents/root/researcher/reviewer/instructions.md
```

The content is the node’s compiled instruction markdown. This includes static extension instruction fragments already composed by the compiler. `defineDynamic` instruction resolvers are excluded.

Only root instructions are also returned through `initialize.instructions`. Local subagent instructions remain addressable resources.

A node without static instructions has no instruction resource.

### Skills

Expose every regular file in every compiled static skill package:

```text
eve://agents/root/skills/research/SKILL.md
eve://agents/root/skills/research/references/catalog.yml
eve://agents/root/researcher/skills/report/scripts/render.ts
```

This includes authored static skills and static skill contributions from extensions. Dynamic skill resolvers are excluded.

Each resource list entry includes:

- canonical percent-encoded URI;
- qualified logical-path name;
- the skill description;
- detected MIME type;
- byte size;
- `_meta["dev.eve/skill"]` containing the agent path, skill name, relative file path, description, license, and authored metadata.

`SKILL.md` is always returned as `text` with `text/markdown`. A deterministic built-in MIME map classifies common textual formats; other formats return base64 `blob` content and default to `application/octet-stream`.

Only regular files are exposed. Symlinks, sockets, devices, and other filesystem entry types are ignored, and resource reads resolve through a precomputed exact-key map rather than joining client-controlled paths.

### Tools

Expose tools from each node’s static `agent.tools` collection when `execute` is present.

This includes:

- authored executable tools;
- static executable tool contributions from extensions;
- an authored replacement whose name happens to match a framework tool.

It excludes:

- dynamic tool resolvers;
- tools without `execute`, including provider-managed or client-resolved tools;
- framework-provided defaults;
- connection-discovered tools;
- local subagent delegation tools;
- remote-agent tools.

Examples:

```text
search
researcher.search
researcher.reviewer.search
```

`tools/list` preserves the authored description and compiled input JSON Schema. A missing schema is represented as an object schema accepting no properties.

The authored output schema is advertised only when it describes an object result and the tool has no `toModelOutput` projection. Otherwise it is omitted because the model-visible result may not match the executor’s raw output schema.

Annotations and task support are omitted because eve has no equivalent authored contract.

Resource and tool lists are sorted lexicographically, return the complete static list, and omit `nextCursor`. A non-empty cursor that eve did not issue is rejected as invalid parameters. Redeployment may change the list, but no `list_changed` notification is emitted.

## Streamable HTTP behavior

The route uses request-scoped JSON response mode:

```text
POST /mcp
Accept: application/json, text/event-stream
Content-Type: application/json
```

Each POST creates a fresh low-level MCP server and Web Standard transport with:

```ts
{
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
}
```

The server never emits `Mcp-Session-Id`, retains no protocol state between HTTP requests, and does not require sticky routing. Clients still perform the stable MCP initialization lifecycle, including the initialized notification, but later requests may be served by any process.

Supported requests are:

- `initialize`;
- `ping`;
- `resources/list`;
- `resources/read`;
- `tools/list`;
- `tools/call`.

Unsupported methods receive JSON-RPC method-not-found errors.

`GET /mcp` and `DELETE /mcp` run origin validation and route authentication, then return `405` with `Allow: POST, OPTIONS`. There is no standalone SSE stream, session termination, replay, or resumability.

`OPTIONS /mcp` validates the origin and returns the applicable CORS preflight response without running route authentication.

Every response uses `Cache-Control: no-store`.

Authentication is transport-level eve route protection. This version does not implement MCP OAuth Protected Resource Metadata, authorization-server discovery, or dynamically generated `WWW-Authenticate` metadata. MCP clients must be configured with credentials that the selected `AuthFn` understands.

The `onRequest` auth projection is distinct from transport admission. It selects the principal visible to direct tool execution after the request has already passed route auth; when omitted, the visible principal is the admitted caller through `defaultMcpAuth`.

## Resource behavior

`resources/list` returns the static instruction and skill-file catalog. `resources/read` returns exactly one content entry for the requested URI.

Unknown or malformed resource URIs return MCP resource-not-found error `-32002`. An advertised resource missing from the deployed artifact is an internal server error, because it indicates a build or packaging defect rather than a missing authored resource.

Resource URI parsing rejects:

- schemes other than `eve`;
- authorities other than `agents`;
- query strings or fragments;
- invalid percent encoding;
- decoded traversal segments;
- paths not present in the static resource map.

The mapping follows the [MCP resources contract](https://modelcontextprotocol.io/specification/2025-11-25/server/resources); no resource templates or subscriptions are needed because every v1 resource is enumerable.

## Direct tool execution

### Execution boundary

`tools/call` does not call `runtime.run()`, create a workflow, or invoke the model harness.

Add an internal `McpCapabilityHost` to Nitro’s private channel route context. It owns the resolved recursive agent graph and exposes three operations to `mcpChannel`:

```ts
interface McpCapabilityHost {
  listResources(): readonly McpStaticResource[];
  readResource(uri: string): Promise<McpResourceContents>;
  listTools(): readonly McpStaticTool[];
  callTool(input: McpToolCallInput): Promise<McpToolCallResult>;
}
```

This interface is internal and eve-owned. Public `Agent`, custom-channel route arguments, and third-party SDK types are not widened.

```text
MCP client
    │
    ▼
/mcp origin + AuthFn boundary
    │
    ▼
optional onRequest projection
    │
    ▼
request-scoped MCP server
    │
    ▼
McpCapabilityHost
    ├── static graph projection ──► instructions and skill bytes
    │
    └── direct tool executor
              │
              ▼
       ephemeral eve context
              │
              ▼
       authored tool execute()
```

### Request projection and ephemeral eve context

A direct call constructs a fresh internal execution scope satisfying the normal `ToolContext` contract without pretending that a durable eve session exists.

The tool-visible session is resolved from `onRequest` with these fallbacks:

```text
session.id                 onRequest.session.id, else mcp:<random UUID>
session.auth.current       onRequest.auth, else route-auth caller
session.auth.initiator     onRequest.session.initiatorAuth, else current auth
session.turn               onRequest.session.turn, else { id: turn_0, sequence: 0 }
session.parent             onRequest.session.parent, else absent
channel                    mcp
mode                       task
subagent depth             local namespace depth
request-input capability   false
```

These values are a context projection, not a persisted eve session. A harness may repeat a logical session id and provide real turn or lineage values so an authored tool sees the surrounding harness conversation, but eve does not create, find, resume, or mutate a `HarnessSession` with them. No continuation token is exposed or persisted.

Each call separately creates a private `mcp:<random UUID>` execution id. The execution id is never author-overridable and owns internal call-scoped resources, including sandbox identity and cleanup. The exposed and approval-facing tool name is the final MCP-qualified name. The tool call id is another independent `mcp:<random UUID>`.

The target node supplies its own sandbox registry, skills, agent configuration, and runtime services. Therefore a nested tool’s `ctx.getSkill()` reads the nested node’s skills rather than the root’s.

Every invocation enters the existing async context container so these APIs behave as they do during an ordinary tool step:

- `ctx.session`;
- `ctx.getSandbox()`;
- `ctx.getSkill()`;
- `ctx.getToken()`;
- `ctx.requireAuth()`;
- `ctx.abortSignal`;
- `ctx.callId`;
- `ctx.toolName`.

No agent lifecycle hooks, dynamic resolvers, session events, action events, model calls, or subagent dispatches run. The channel-level `onRequest` projection is the only authored request hook in this path.

Calls from the same MCP client remain independent even when `onRequest` returns the same logical session id. Approval state, sandbox state, turn state, and continuation state never carry between calls. External systems and principal-scoped credential caches may naturally retain their own state.

### Validation and approval

Treat omitted `arguments` as `{}`.

Validate arguments before approval or execution. Prefer the reattached live Standard Schema so transforms and defaults are preserved; otherwise validate against the compiled JSON Schema. The transformed value is passed to the approval callback and executor.

Approval uses the existing eve contract with an empty `approvedTools` set:

| Approval result                                        | MCP behavior                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `undefined`, `false`, `"not-applicable"`, `"approved"` | Execute                                                      |
| `true`, `"user-approval"`                              | Return `isError: true`; no interactive approval is available |
| `"denied"`                                             | Return `isError: true`; do not execute                       |
| Callback throws                                        | Return `isError: true`; do not execute                       |

Object-form statuses follow the same mapping. `once()` requests approval on every fresh MCP call and is therefore non-executable through this channel unless the author supplies a policy that can approve from the authenticated context.

The channel never bypasses an authored approval policy.

### Tool authorization

Wrap execution with the existing tool-auth implementation.

Non-interactive authorization can work when the authenticated principal and configured provider can resolve a token immediately. Cached principal-scoped credentials may also work.

An interactive authorization request cannot park and resume because the MCP call has no durable eve session or callback route. It returns a sanitized `isError: true` result explaining that interactive authorization is unsupported. Authorization URLs, challenges, and raw provider errors are not returned to the external model.

### Sandbox lifecycle

Sandbox access remains lazy. A call that never invokes `ctx.getSandbox()` or `ctx.getSkill()` creates no sandbox.

A sandbox opened by the first accessor is created from the owning node's sandbox registry and reusable prewarmed template. Repeated `ctx.getSandbox()` calls within that tool invocation return the same live handle. A nested local agent tool uses that node's registry, template, workspace, and skills rather than the root's.

The live sandbox is keyed by the private execution id and owning node id, never by the logical `session.id` returned from `onRequest`. Reusing a harness session id therefore cannot reattach a prior sandbox or collide with another caller. Templates may be reused, but each call receives fresh writable state.

A sandbox created for an MCP tool call is ephemeral and must be shut down in `finally` on success, failure, or request abort. Add an internal idempotent per-access `dispose()` operation that shuts down and untracks only that exact handle; do not call the process-wide sandbox shutdown registry. Disposal must tolerate a never-opened access and must not remove a newer handle that happens to share a backend registry entry.

MCP execution does not call `captureState()`: there is no durable harness session in which to retain `SandboxState`. An authored sandbox `onSession` hook runs once per MCP call that opens a sandbox.

No sandbox identifier or filesystem state survives into another MCP call. Harness-keyed persistent sandboxes are deferred as a separate explicit mode because they require a principal- and node-scoped durable key, saved `SandboxState`, concurrency control, expiry, and reset semantics.

### Result projection

Validate the raw result against the authored output schema when present, then apply the same model-facing projection as eve’s harness:

1. If `toModelOutput` exists, return only its projected result.
2. Otherwise return strings as text.
3. Otherwise normalize `undefined` to `null` and return JSON.

Never expose the raw executor output alongside `toModelOutput`; that projection is an eve data-disclosure boundary.

Return results as follows:

- text projection: one MCP text content block;
- JSON object: compact serialized JSON text plus identical `structuredContent`;
- JSON array, primitive, or `null`: compact serialized JSON text only.

This follows the [MCP tools result guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), including the compatibility text block for structured output.

Input validation, approval, authorization, executor, output-validation, and projection failures return a tool result with `isError: true` and a safe text message. Unknown tools and malformed `tools/call` requests remain JSON-RPC protocol errors.

## Error model

| Failure                                  | Result                                          |
| ---------------------------------------- | ----------------------------------------------- |
| Invalid Origin                           | HTTP `403`                                      |
| Authentication failure                   | Existing `AuthFn` response, normally HTTP `401` |
| Unsupported HTTP method                  | HTTP `405`                                      |
| Invalid JSON                             | JSON-RPC `-32700`                               |
| Invalid JSON-RPC request                 | JSON-RPC `-32600`                               |
| Unsupported MCP method                   | JSON-RPC `-32601`                               |
| Unknown tool or malformed call           | JSON-RPC `-32602`                               |
| Unknown resource                         | MCP `-32002`                                    |
| Invalid or failed `onRequest` projection | JSON-RPC `-32603`                               |
| Input or output validation failure       | Tool result with `isError: true`                |
| Approval or authorization unavailable    | Tool result with `isError: true`                |
| Authored executor failure                | Tool result with `isError: true`                |
| Framework defect                         | JSON-RPC `-32603`                               |

Error responses never include stack traces, generated authorization URLs, environment values, or raw internal context.

The request’s `AbortSignal` is forwarded through tool context. A disconnected request aborts cooperative tool and sandbox work and still runs cleanup.

## Compilation and deployment

The existing compiled manifest retains static instructions and skill descriptors but deliberately removes skill package bytes after materializing `.eve/compile/workspace-resources`. Production channel code cannot assume the authored filesystem or that directory is available.

When an authored root MCP channel is present, generate an app-only resource index containing:

- node id and local namespace;
- resource URI and metadata;
- the relative path of the corresponding private asset.

Trace the indexed instruction and skill files into a private MCP asset tree in the app function package. Preserve their raw bytes rather than embedding text or base64 data in a generated module. `resources/list` reads only the index; `resources/read` reads only the exact indexed asset and base64-encodes binary content at the MCP response boundary. These assets have no public URL and are reachable only through the authenticated route.

Runtime behavior remains in the eve package; the generated index and asset tree contain data only. Development may read the active compiled workspace-resource snapshot through the same reader interface. Production and Vercel-shaped applications use the traced private assets. Workflow and flow bundles must not receive the index or MCP resource bytes.

The index and assets are generated only for applications that opt into `mcpChannel()`. The app function grows by the raw size of the exposed static resources plus the small index. Changing instructions or skill files requires recompilation or development reload, matching the static v1 contract.

## Security and operations

`mcpChannel()` makes authored instructions, skill files, and executable tools available to every principal admitted by its route policy. Documentation must warn authors not to place secrets in static instruction or skill content.

The channel enforces:

- explicit route authentication;
- Origin validation;
- exact resource lookup without traversal;
- no symlink reads;
- input and output validation;
- authored approval policies;
- model-output projection;
- request cancellation;
- sandbox cleanup;
- sanitized errors;
- complete exclusion of remote subagents.

The [MCP tools security guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) also requires access control, rate limiting, and auditability. Access control is provided by `AuthFn`. Production deployments must add distributed request limiting at ingress or in a custom `AuthFn`; an in-process limiter is intentionally rejected because it is ineffective across serverless instances.

Emit framework-owned structured diagnostics for MCP tool name, owning agent path, admitted and effective principal identifiers when they differ, duration, and outcome classification. Do not log tool arguments, results, instruction contents, skill bytes, credentials, or authorization challenges by default.

## Implementation sequence

1. Vendor the stable MCP server and Web Standard transport, then add the authenticated `/mcp` route with initialize, ping, Origin, CORS, `defaultMcpAuth`, `onRequest`, and JSON response behavior.
2. Build deterministic local-agent traversal, resource URIs, tool namespaces, and validation while proving remote and dynamic entries are absent.
3. Add the app-only static resource artifact and readers for development, self-hosted production, and Vercel-shaped builds.
4. Factor shared tool validation, approval, authorization, and output projection into a request-scoped direct executor; add ephemeral sandbox disposal.
5. Publish `eve/channels/mcp`, document client configuration and security constraints, add the channel docs to navigation, and include a patch changeset.

The public channel should not ship until static reads and direct static tool calls work together; there is no read-only preview API to preserve.

## Verification

### Protocol and transport

- An official MCP client initializes against `/mcp`, receives root instructions, pings, lists resources and tools, reads resources, and calls a tool.
- Responses negotiate the stable protocol and use JSON response mode without `Mcp-Session-Id`.
- GET and DELETE return authenticated `405`; unsupported MCP methods return `-32601`.
- Origin, CORS preflight, route-auth ordering, malformed JSON, content type, and accept-header cases match the documented behavior.
- An omitted `onRequest` projects `defaultMcpAuth`; a custom hook receives the admitted caller and original request, can replace every documented logical session field, and cannot run after route-auth rejection.
- Invalid and thrown `onRequest` results fail safely without invoking a tool or leaking internal details.
- Separate requests and separate processes produce identical lists without shared server state.

### Capability projection

Use a fixture containing:

- root instructions, text and binary skill files, and an executable tool;
- a local `researcher` subagent;
- a nested local `reviewer` subagent;
- a remote sibling;
- static extension contributions;
- dynamic instructions, skills, and tools;
- a provider-managed tool without `execute`;
- framework defaults.

Assert the exact resource URIs and tool names. Assert that no remote, dynamic, framework, provider-managed, connection, or delegation capability appears.

Cover invalid MCP names, overlength names, root-versus-child collisions, deterministic ordering, canonical URI encoding, unknown cursors, traversal attempts, symlinks, MIME classification, and binary base64 output.

### Direct execution

- Standard Schema transforms and defaults reach approval and `execute`.
- Compiled JSON Schema rejects invalid input with `isError: true`.
- Root and nested tools receive the documented session, auth, turn, depth, call id, and qualified tool name.
- Calls without a logical id override receive distinct fallback session ids; all calls receive distinct private execution and call ids.
- Calls that repeat an authored logical session id still share no approval, continuation, or sandbox state.
- `ctx.getSkill()` resolves against the owning node.
- Immediate and cached authorization succeeds; interactive authorization fails safely without leaking a URL.
- Every approval status follows the matrix and denied calls never execute.
- Raw outputs validate before projection.
- `toModelOutput` prevents the raw value from reaching MCP.
- Text, object, array, primitive, null, execution errors, projection errors, and aborted calls serialize correctly.
- Lazy sandboxes are absent when unused, reused within one invocation, and shut down exactly once when used.
- Root and nested tools provision from their own templates, and repeated logical session ids produce distinct live sandbox keys and writable state.
- Parallel calls keep auth and async context isolated.

### Packaging and repository checks

- Development, production Nitro, and Vercel-shaped scenario builds can read identical resource bytes.
- MCP resources are raw private assets indexed only in the app surface, are absent from generated JavaScript data, and do not enter workflow or flow bundles.
- Resource listing does not read asset bytes, and resource reads do not create a sandbox.
- Public API exports, declaration generation, documentation, and package publishing are covered.
- Run targeted unit, integration, and scenario suites, followed by format, lint, typecheck, invariant guard, docs validation, and the full unit tier.

## Deferred work

- Dynamic instructions, skills, and tools.
- Connection-discovered and provider-managed tools.
- Remote subagents in any form.
- Invoking local subagents as agents rather than exposing their static contents.
- Durable eve sessions, conversation history, model turns, hooks, or event streams.
- Stateful MCP sessions, SSE, resumability, server notifications, progress, and cross-request cancellation.
- Interactive approval and authorization.
- MCP OAuth discovery and Protected Resource Metadata.
- MCP prompts, resource templates, subscriptions, sampling, elicitation, tasks, and completions.
- Configurable route paths, capability filters, aliases, or per-tool exposure policies.
- Persistence of sandbox or approval state between calls.

## Success criteria

- An external harness can consume the same compiled static instructions and complete skill packages that eve built for the root and every local subagent.
- It can call every eligible static executable tool directly with normal eve auth, schema, approval, tool-context, sandbox, and output-projection guarantees.
- Remote subagents and dynamic/runtime-discovered capabilities are completely absent.
- Each tool call is isolated and creates no durable eve run or model invocation.
- The endpoint works in development, self-hosted Nitro, and Vercel-shaped deployments without sticky routing or new runtime dependencies.
- The small v1 surface leaves room to add dynamic capabilities or stateful execution later without changing the static names and URIs.
