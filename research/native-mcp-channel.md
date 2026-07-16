---
issue: https://github.com/vercel/eve/issues/883
status: proposed
last_updated: "2026-07-16"
---

# Native MCP channel

## Summary

Add an opt-in `mcpChannel()` that exposes an eve agent to external agent
harnesses through the Model Context Protocol.

v1 exposes only the root agent's capabilities known when the agent is
compiled:

- compiled static instructions;
- complete static skill packages;
- statically authored executable tools.

Everything else is out of scope for v1 — subagents (local or remote), dynamic
instructions, skills, and tools, framework tools, provider-managed tools,
connection-discovered tools, and delegation tools. See "Deferred work."

Tool calls execute directly in the agent node. They do not create an eve run,
invoke a model, or write durable session history. Each call receives a
request-scoped eve context populated from the authenticated MCP request and an
optional authored `onRequest` projection.

"Static tool" describes how the tool is discovered, not its effects. An
exposed tool may still call APIs, use a sandbox, or mutate external systems.

## Protocol target

Target the current stable MCP revision,
[`2025-11-25`](https://modelcontextprotocol.io/docs/learn/versioning), using
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

Use the stable official TypeScript SDK v1 line. Vendor the required low-level
server, schemas, and Web Standard transport through eve's compiled-dependency
system so `nitro` remains the only runtime dependency.

The server declares only:

```json
{
  "capabilities": {
    "resources": {},
    "tools": {}
  }
}
```

`prompts`, `logging`, `tasks`, `sampling`, `elicitation`, `completions`,
resource subscriptions, and list-changed notifications are not advertised.

The initialization result uses:

- `serverInfo.name`: the authored agent name when configured, otherwise
  `"eve"`;
- `serverInfo.version`: the installed eve package version;
- `instructions`: the compiled static instructions, when present, exactly as
  compiled — no generated MCP guidance or skill summaries are appended.

## Public authoring API

```ts
// agent/channels/mcp.ts
import { localDev, vercelOidc } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth: [vercelOidc(), localDev()],
  onRequest(ctx) {
    const sessionId = ctx.request.headers.get("x-harness-session-id");
    return sessionId === null ? {} : { sessionId };
  },
});
```

Add the public surface:

```ts
export interface McpRequestContext {
  /** Route-auth result for the request. */
  readonly caller: SessionAuthContext | null;
  readonly request: Request;
}

export interface McpRequestResult {
  /** Session auth visible to tool execution. Omitted: the admitted caller. */
  readonly auth?: SessionAuthContext | null;
  /** Logical session id visible to tool execution. Omitted: a per-call id. */
  readonly sessionId?: string;
}

export interface McpChannelInput {
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Route path. Defaults to "/eve/v1/mcp". */
  readonly route?: string;
  /** Browser CORS policy, identical to eveChannel({ cors }). */
  readonly cors?: EveChannelCors;
  readonly onRequest?: (
    ctx: McpRequestContext,
  ) => McpRequestResult | null | Promise<McpRequestResult | null>;
}

export interface McpChannel extends Channel {}

export function defaultMcpAuth(ctx: McpRequestContext): SessionAuthContext | null;
export function mcpChannel(input: McpChannelInput): McpChannel;
```

`mcpChannel()` is exported from `eve/channels/mcp` and mounts a single route,
`/eve/v1/mcp` by default, overridable through `route` like every other
channel. The channel is explicit opt-in: it is not added to the framework's
default channels, and no MCP route exists unless the application authors
`agent/channels/mcp.ts`.

`auth` is required and uses the existing ordered `AuthFn` and `routeAuth`
behavior. Authors may explicitly use `none()` for a public server, but the API
never defaults to anonymous access.

`cors` reuses the eve HTTP channel's `EveChannelCors` shape and normalization.
When omitted, no CORS headers are emitted and any request whose `Origin`
header differs from the origin of the request URL as observed by the server
is rejected with `403`; requests without `Origin` (ordinary MCP clients) and
same-origin browser requests pass. This satisfies the MCP DNS-rebinding
guidance. When configured, origins allowed by the policy receive normal CORS
and preflight handling; all other cross-origin requests receive `403`.

`onRequest` is optional and runs once for each authenticated, protocol-valid
`POST`, after origin and route-auth checks and before method dispatch.
Returning `{}` — or omitting the hook — projects the admitted route caller as
the tool-visible auth and a fresh per-call session id. Returning `null`
rejects the request with `403`. A thrown error is logged with a framework
error id and returned as a sanitized JSON-RPC internal error. The hook cannot
bypass route authentication because rejected requests never reach it, and its
result is scoped to that single POST. Only tool execution consumes the
projection; list and read handlers ignore it.

`defaultMcpAuth(ctx)` returns `ctx.caller` unchanged — the same projection
applied when `auth` is omitted — matching the default-auth helpers shipped by
eve's other channels. A custom hook calls it when branching logic overrides
`auth` on some requests and wants to state the default explicitly on others:

```ts
onRequest(ctx) {
  if (isServiceAccount(ctx.caller)) return { auth: impersonatedAuth(ctx.request) };
  return { auth: defaultMcpAuth(ctx) };
}
```

## Static capability projection

### Instructions

Expose one resource when compiled static instructions exist:

```text
eve://agent/instructions.md
```

The content is the compiled instruction markdown, including static extension
fragments already composed by the compiler; `defineDynamic` resolvers are
excluded. The same content is returned through `initialize.instructions`.

### Skills

Expose every regular file in every compiled static skill package:

```text
eve://agent/skills/research/SKILL.md
eve://agent/skills/research/references/catalog.yml
```

This includes authored static skills and static skill contributions from
extensions; dynamic skill resolvers are excluded.

Each resource list entry carries the canonical percent-encoded URI, the
logical-path name, the skill description, detected MIME type, byte size, and
`_meta["dev.eve/skill"]` (skill name, relative file path, description,
license, and authored metadata).

`SKILL.md` is always returned as `text` with `text/markdown`. A deterministic
built-in MIME map classifies common textual formats; other formats return
base64 `blob` content as `application/octet-stream`.

Only regular files are exposed — no symlinks, sockets, or devices — and
resource reads resolve through a precomputed exact-key map, never by joining
client-controlled paths.

### Tools

Expose tools from the root agent's static `agent.tools` collection when
`execute` is present. Authored tools that shadow framework tool names are
treated as ordinary authored tools.

Excluded: dynamic tool resolvers, tools without `execute` (including
provider-managed and client-resolved tools), framework defaults,
connection-discovered tools, and subagent delegation tools.

MCP tool names are the authored names, unchanged. A name that violates the
[MCP tool-name rules](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
(1–128 characters; ASCII letters, digits, `_`, `-`, `.`) fails capability
construction with the source path in the diagnostic. Names are never silently
sanitized.

`tools/list` preserves the authored description and compiled input JSON
Schema. A missing schema is represented as an object schema accepting no
properties. The authored output schema is advertised only when it describes an
object result and the tool has no `toModelOutput` projection; otherwise the
model-visible result may not match the raw output schema. Annotations and task
support are omitted because eve has no equivalent authored contract.

Resource and tool lists are sorted lexicographically, return the complete
static list, and omit `nextCursor`. A non-empty cursor that eve did not issue
is rejected as invalid parameters. Redeployment may change the lists, but no
`list_changed` notification is emitted.

## Streamable HTTP behavior

The route uses request-scoped JSON response mode:

```text
POST /eve/v1/mcp
Accept: application/json, text/event-stream
Content-Type: application/json
```

Each POST creates a fresh low-level MCP server and Web Standard transport
with:

```ts
{
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
}
```

The server never emits `Mcp-Session-Id`, retains no protocol state between
HTTP requests, and does not require sticky routing. Clients still perform the
standard MCP initialization lifecycle, but later requests may be served by any
process.

Supported requests are `initialize`, `ping`, `resources/list`,
`resources/read`, `tools/list`, and `tools/call`. Unsupported methods receive
JSON-RPC method-not-found errors.

`GET` and `DELETE` run origin validation and route authentication, then
return `405` with `Allow: POST, OPTIONS`. There is no standalone SSE stream,
session termination, replay, or resumability. `OPTIONS` validates the origin
and returns the applicable CORS preflight response without running route
authentication. Every response uses `Cache-Control: no-store`.

Authentication is transport-level eve route protection. This version does not
implement MCP OAuth Protected Resource Metadata, authorization-server
discovery, or `WWW-Authenticate` metadata; MCP clients must be configured with
credentials that the selected `AuthFn` understands.

## Resource behavior

`resources/list` returns the static instruction and skill-file catalog.
`resources/read` returns exactly one content entry for the requested URI.

Unknown or malformed resource URIs return MCP resource-not-found error
`-32002`. An advertised resource missing from the deployed artifact is an
internal server error, because it indicates a packaging defect rather than a
missing authored resource.

Resource URI parsing rejects schemes other than `eve`, authorities other than
`agent`, query strings or fragments, invalid percent encoding, decoded
traversal segments, and paths not present in the static resource map.

The mapping follows the
[MCP resources contract](https://modelcontextprotocol.io/specification/2025-11-25/server/resources);
no resource templates or subscriptions are needed because every v1 resource is
enumerable.

## Direct tool execution

### Execution boundary

`tools/call` does not call `runtime.run()`, create a workflow, or invoke the
model harness. An internal, eve-owned capability host owns the static
projection and the direct executor; public `Agent`, custom-channel route
arguments, and third-party SDK types are not widened.

```text
MCP client
    │
    ▼
origin + route-auth boundary
    │
    ▼
optional onRequest projection
    │
    ▼
request-scoped MCP server
    ├── static projection ──► instructions and skill bytes
    │
    └── direct executor ──► ephemeral eve context ──► authored execute()
```

### Ephemeral eve context

A direct call constructs a fresh execution scope satisfying the normal
`ToolContext` contract without a durable eve session:

```text
session.id               onRequest sessionId, else mcp:<random UUID>
session.auth.current     onRequest auth, else the admitted route caller
session.auth.initiator   same as session.auth.current
session.turn             { id: "turn_0", sequence: 0 }
session.parent           absent
```

The channel is `mcp` and the run mode is `task`, so authored code that
branches on conversation-versus-task behavior sees a task step. There is no
interactive input capability: tools cannot park for user input over this
channel.

These values are a projection, not a persisted session. A harness may repeat a
logical `sessionId` so authored tools can key external state, but eve never
creates, resumes, or mutates a `HarnessSession`, and no continuation token
exists. Each call also receives a private `mcp:<random UUID>` execution id —
never author-overridable — that owns call-scoped resources such as sandbox
identity, plus an independent call id. `ctx.toolName` is the authored tool
name.

Every invocation enters the existing async context container, so
`ctx.session`, `ctx.getSandbox()`, `ctx.getSkill()`, `ctx.getToken()`,
`ctx.requireAuth()`, `ctx.abortSignal`, `ctx.callId`, and `ctx.toolName`
behave as they do during an ordinary tool step. No agent lifecycle hooks,
dynamic resolvers, session events, model calls, or subagent dispatches run.
Calls remain fully independent even when they share a logical `sessionId`:
approval, sandbox, and turn state never carry between calls.

### Validation and approval

Treat omitted `arguments` as `{}`. Validate arguments before approval or
execution: prefer the reattached live Standard Schema so transforms and
defaults are preserved, otherwise validate against the compiled JSON Schema.
The transformed value is passed to the approval callback and executor.

Approval uses the existing eve contract with an empty `approvedTools` set:

| Approval result                                        | MCP behavior                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `undefined`, `false`, `"not-applicable"`, `"approved"` | Execute                                                      |
| `true`, `"user-approval"`                              | Return `isError: true`; no interactive approval is available |
| `"denied"`                                             | Return `isError: true`; do not execute                       |
| Callback throws                                        | Return `isError: true`; do not execute                       |

Object-form statuses follow the same mapping. `once()` requests approval on
every fresh MCP call, so `once()`-gated tools are effectively unusable over
this channel; only a policy that can approve from the authenticated context
alone can execute. The channel never bypasses an authored approval policy.

### Tool authorization

Wrap execution with the existing tool-auth implementation. Immediate token
resolution — a configured provider or cached principal-scoped credentials —
works. An interactive authorization request cannot park and resume because
there is no durable session or callback route; it returns a sanitized
`isError: true` result. Authorization URLs, challenges, and raw provider
errors are never returned to the external model.

### Sandbox lifecycle

Sandbox access stays lazy: a call that never invokes `ctx.getSandbox()` or
`ctx.getSkill()` creates no sandbox. The first accessor provisions from the
agent's sandbox registry and prewarmed template, and the handle is reused
within that invocation. The live sandbox is keyed by the private execution id,
never the logical `sessionId`, so repeating a harness session id cannot
reattach a prior sandbox or collide with another caller.

Every sandbox opened for an MCP call is ephemeral: it is disposed exactly once
in `finally` on success, failure, or abort, and no identifier or filesystem
state survives into another call. `captureState()` is never called — there is
no durable session in which to retain `SandboxState`. An authored sandbox
`onSession` hook runs once per call that opens a sandbox.

### Result projection

Validate the raw result against the authored output schema when present, then
apply the same model-facing projection as eve's harness:

1. If `toModelOutput` exists, return only its projected result.
2. Otherwise return strings as text.
3. Otherwise normalize `undefined` to `null` and return JSON.

Never expose the raw executor output alongside `toModelOutput`; that
projection is an eve data-disclosure boundary.

Return results as follows:

- text projection: one MCP text content block;
- JSON object: compact serialized JSON text plus identical
  `structuredContent`;
- JSON array, primitive, or `null`: compact serialized JSON text only.

This follows the
[MCP tools result guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools),
including the compatibility text block for structured output.

Input validation, approval, authorization, executor, output-validation, and
projection failures return a tool result with `isError: true` and a safe text
message. Unknown tools and malformed `tools/call` requests remain JSON-RPC
protocol errors.

## Error model

| Failure                            | Result                                          |
| ---------------------------------- | ----------------------------------------------- |
| Invalid Origin                     | HTTP `403`                                      |
| Authentication failure             | Existing `AuthFn` response, normally HTTP `401` |
| `onRequest` returned `null`        | HTTP `403`                                      |
| Unsupported HTTP method            | HTTP `405`                                      |
| Invalid JSON                       | JSON-RPC `-32700`                               |
| Invalid JSON-RPC request           | JSON-RPC `-32600`                               |
| Unsupported MCP method             | JSON-RPC `-32601`                               |
| Unknown tool or malformed call     | JSON-RPC `-32602`                               |
| Unknown resource                   | MCP `-32002`                                    |
| Thrown `onRequest` error           | JSON-RPC `-32603`                               |
| Input or output validation failure | Tool result with `isError: true`                |
| Approval or authorization blocked  | Tool result with `isError: true`                |
| Authored executor failure          | Tool result with `isError: true`                |
| Framework defect                   | JSON-RPC `-32603`                               |

Error responses never include stack traces, authorization URLs, environment
values, or raw internal context. The request's `AbortSignal` is forwarded
through tool context; a disconnected request aborts cooperative tool and
sandbox work and still runs cleanup.

## Compilation and deployment

The compiled manifest keeps static instructions and skill descriptors but
drops skill package bytes after materializing
`.eve/compile/workspace-resources`, so production channel code cannot assume
the authored filesystem exists.

When `agent/channels/mcp.ts` is present, compilation emits an app-only
resource index (URI, metadata, relative asset path) and traces the indexed
instruction and skill files into a private asset tree in the app function
package, preserving raw bytes.

Invariants:

- assets have no public URL and are reachable only through the authenticated
  route;
- the index and asset tree contain data only — runtime behavior stays in the
  eve package;
- workflow and flow bundles never receive the index or resource bytes;
- development reads the active compiled workspace snapshot through the same
  reader interface used by self-hosted production and Vercel-shaped builds.

The app function grows by the raw size of the exposed resources plus the small
index. Changing instructions or skill files requires recompilation or
development reload, matching the static v1 contract.

## Security and operations

`mcpChannel()` makes authored instructions, skill files, and executable tools
available to every principal its route policy admits. Documentation must warn
authors not to place secrets in static instruction or skill content.

Beyond route authentication and origin validation, the channel enforces
exact-key resource lookup (no traversal, no symlinks), input and output
validation, authored approval policies, the `toModelOutput` disclosure
boundary, request cancellation, sandbox cleanup, and sanitized errors.

The [MCP tools security guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
also expects rate limiting and auditability. Production deployments must add
distributed request limiting at ingress or in a custom `AuthFn`; an in-process
limiter is intentionally rejected because it is ineffective across serverless
instances. Emit framework-owned structured diagnostics for tool name, admitted
and effective principal identifiers when they differ, duration, and outcome
classification. Do not log tool arguments, results, instruction contents,
skill bytes, credentials, or authorization challenges by default.

## Implementation sequence

1. Vendor the stable MCP server and Web Standard transport; add the
   authenticated route with initialize, ping, origin/CORS, `onRequest`, and
   JSON response behavior.
2. Build the static root projection — resource URIs, tool list, name
   validation — proving dynamic, framework, provider-managed, connection, and
   subagent capabilities are absent.
3. Add the app-only resource index, private asset tree, and shared reader for
   development, self-hosted, and Vercel-shaped builds.
4. Factor shared validation, approval, authorization, and output projection
   into a request-scoped direct executor with ephemeral sandbox disposal.
5. Publish `eve/channels/mcp`, document client configuration and security
   constraints, add the channel docs to navigation, and include a patch
   changeset.

The channel should not ship until static reads and direct tool calls work
together; there is no read-only preview API to preserve.

## Verification

Use a fixture containing root instructions, text and binary skill files, and
an executable tool, plus everything that must not appear: a local subagent, a
remote subagent, static extension contributions, dynamic instructions, skills,
and tools, a provider-managed tool without `execute`, and framework defaults.
Assert the exact resource URIs and tool names, and that nothing outside the
static root projection appears.

Key invariants to cover:

- An official MCP client initializes, pings, lists, reads, and calls tools
  over JSON response mode without `Mcp-Session-Id`; separate requests and
  separate processes produce identical lists.
- Origin, CORS preflight, route-auth ordering, `405` methods,
  unsupported-method `-32601`, malformed JSON, and unknown-cursor rejection
  match the documented behavior.
- `onRequest`: omitted projects the admitted caller and a per-call session id;
  `null` rejects with `403` before dispatch; a thrown error returns a
  sanitized `-32603`; the hook never runs after an auth rejection.
- Name-validation failures, deterministic ordering, canonical URI encoding,
  traversal and symlink rejection, MIME classification, and base64 blob
  output.
- Standard Schema transforms and defaults reach approval and `execute`;
  invalid input and output return `isError: true`; every approval status
  follows the matrix and denied calls never execute.
- Immediate and cached authorization succeeds; interactive authorization fails
  safely without leaking a URL.
- `toModelOutput` prevents raw values from reaching MCP; text, object, array,
  primitive, null, error, and aborted results serialize correctly.
- Sandboxes are absent when unused, reused within one invocation, disposed
  exactly once, and keyed by execution id; repeated logical session ids share
  no state and parallel calls stay isolated.
- Development, production Nitro, and Vercel-shaped builds read identical
  resource bytes; assets stay out of generated JavaScript and workflow/flow
  bundles; resource listing never reads asset bytes.

## Deferred work

- Local subagent projection — nested instructions, skills, and tools — and any
  tool-name namespacing it requires.
- Richer session projection: harness-supplied turn, parent lineage, and
  initiator auth.
- Dynamic instructions, skills, and tools; connection-discovered and
  provider-managed tools; remote subagents in any form.
- Durable eve sessions, conversation history, model turns, hooks, or event
  streams.
- Stateful MCP sessions, SSE, resumability, server notifications, progress,
  and cross-request cancellation.
- Interactive approval and authorization.
- MCP OAuth discovery and Protected Resource Metadata.
- MCP prompts, resource templates, subscriptions, sampling, elicitation,
  tasks, and completions.
- Capability filters and per-tool exposure policies.
- Persistence of sandbox or approval state between calls.

## Success criteria

- An external harness can consume the compiled static instructions and
  complete skill packages eve built for the agent, and call every eligible
  static executable tool with normal eve auth, schema, approval, tool-context,
  sandbox, and output-projection guarantees.
- Subagents and dynamic or runtime-discovered capabilities are completely
  absent.
- Each tool call is isolated and creates no durable eve run or model
  invocation.
- The endpoint works in development, self-hosted Nitro, and Vercel-shaped
  deployments without sticky routing or new runtime dependencies.
- The v1 surface — one channel factory, one hook, root-only static names and
  URIs — leaves room for subagent projection, dynamic capabilities, and
  stateful execution without breaking changes.
