---
issue: TBD
status: proposed
last_updated: "2026-07-21"
---

# Channel-scoped dynamic tools

This proposal is intentionally split into two deliverables:

1. **Part I — Channel-scoped tools API** defines and implements the
   transport-neutral framework capability. It ships first and does not change
   any platform channel's built-in behavior.
2. **Part II — Slack features** follows after Part I and uses only that public
   API to add Slack-specific tools and delivery behavior.

## Part I — Channel-scoped tools API

### Summary

Channels need to contribute tools that exist only for turns running through
that channel. The tool set may depend on the current caller, channel state, or
an asynchronous policy check, and tool executors need the channel's live
context so they can reuse inherited credentials without serializing them.

Add an async, per-turn `tools` resolver to `defineChannel`. It returns a
record-keyed overlay of ordinary `defineTool(...)` definitions and
`disableTool()` sentinels. The resolver and its tool executors receive the
channel context returned by `context(...)`, in addition to their existing eve
context.

### Public authoring API

```ts
import { defineChannel, POST } from "eve/channels";
import { z } from "zod";

export default defineChannel({
  state: {
    workspaceId: null as string | null,
  },

  context(state, session) {
    return {
      state,
      acme: createAcmeClient(credentials),
    };
  },

  async tools(ctx, { defineTool, disableTool }) {
    const caller = ctx.session.auth.current;
    const canPost = caller?.attributes.canPost === true;

    return {
      post_acme_message: canPost
        ? defineTool({
            description: "Post a message to an Acme room.",
            inputSchema: z.object({
              roomId: z.string(),
              text: z.string(),
            }),
            async execute({ roomId, text }, ctx) {
              await ctx.acme.postMessage(roomId, text);
              return { roomId };
            },
          })
        : disableTool(),
    };
  },

  routes: [POST("/acme", handler)],
});
```

`tools` has this conceptual public shape:

```ts
type ChannelToolEntry<TContext> =
  ChannelToolDefinition<TContext, unknown, unknown> | DisabledToolSentinel;

type ChannelToolEntries<TContext> = Readonly<Record<string, ChannelToolEntry<TContext>>>;

type ChannelToolResolver<TContext> = (
  ctx: ChannelToolResolverContext<TContext>,
  helpers: ChannelToolAuthoring<TContext>,
) => ChannelToolEntries<TContext> | null | Promise<ChannelToolEntries<TContext> | null>;
```

The concrete declarations should preserve all existing `defineTool` schema
overloads rather than expose `unknown` to authors.

- `ChannelToolResolverContext<TContext>` combines `SessionContext` with the
  channel's inferred `context(...)` return. The current inbound caller is
  available at `ctx.session.auth.current`; the session initiator remains at
  `ctx.session.auth.initiator`.
- The resolver's scoped `defineTool` is the canonical eve tool helper with its
  executor context bound to `ToolContext & TContext`. It retains input/output
  schema inference, approvals, `toModelOutput`, branding, and validation.
- The resolver's `disableTool` is the existing sentinel helper. The containing
  record key supplies the target name, replacing the filesystem path used by
  `agent/tools/<name>.ts`.
- Tool names are the bare record keys. They are not automatically prefixed by
  the channel name.
- Framework-owned `SessionContext` and `ToolContext` fields are reserved and
  cannot be shadowed by the channel context.

### Resolution and overlay semantics

eve awaits the resolver once per turn, after the channel's `turn.started`
handler has hydrated current auth and channel state and before the first model
call. A new inbound caller therefore produces a newly resolved tool set on the
next turn.

The returned record is an overlay applied after framework, authored,
extension, and ordinary dynamic tools:

- an omitted key leaves the existing tool unchanged;
- `defineTool(...)` adds the key or intentionally replaces its active
  definition for this channel turn;
- `disableTool()` removes the key for this channel turn;
- `null` and an empty record make no changes.

The channel overlay remains last in precedence for every model call, including
when a `step.started` dynamic resolver contributes a matching name. Resolver
failure fails the turn rather than reusing a previous caller's overlay or
silently exposing a tool the resolver may have intended to remove.

The resolved overlay is durable for the rest of the turn. Workflow replay uses
the recorded result instead of repeating asynchronous policy checks. A later
turn invokes the resolver again. Returned executors follow the existing
dynamic-tool requirement that `execute` be inline and captured values be
serializable.

The live channel context is reconstructed for each tool execution and merged
with `ToolContext`. Executors should use that fresh context rather than capture
API handles from the resolver. Credentials, clients, and session handles never
enter durable tool metadata.

Channel tools are available only to the root session whose active adapter owns
the resolver. They persist across follow-up turns on that channel and do not
propagate into delegated subagents, schedules, framework HTTP sessions, or
sessions on a different channel. A cross-channel `receive(...)` starts a root
session owned by the target adapter, so that target resolves its own tools.

### Implementation boundaries

Reuse the existing dynamic-tool serialization and replay machinery for the
resolved overlay, while associating the durable result with the active channel
adapter and turn. The compiler must apply the existing inline-executor
transform to tools returned from channel resolvers.

The adapter registry continues to reattach channel behavior and construct live
context after each workflow boundary. The harness merges the recorded channel
overlay into its effective tool map last and must reject execution when the
active adapter does not own that overlay.

`eve info` should list these as conditional tools under their owning channel,
not as globally available agent tools.

### Validation

- Type tests cover schema inference, resolver and executor access to custom
  channel context, protected context fields, and ordinary tools remaining
  limited to `ToolContext`.
- Runtime tests cover async caller-based resolution, add/replace/disable
  overlays, precedence over step-dynamic tools, resolver failure, and a new
  overlay on the next turn.
- Durability tests prove replay does not rerun the resolver, inline closure data
  survives, and live clients or credentials are never serialized.
- Scope tests cover custom-channel roots, follow-up turns, cross-channel
  receive, and absence from other channels and subagents.
- Update the custom channel, dynamic capabilities, and TypeScript API
  documentation, and include a patch changeset for the published `eve` package.

Part I is complete when custom channels can define, resolve, execute, disable,
and durably replay channel-scoped tools. It must not add bundled tools or
special-case any platform adapter.

## Part II — Slack features built on the API

Part II begins only after Part I lands. It adds Slack behavior by authoring
channel tools and state through the public API; it must not introduce a private
Slack-only tool registry or execution path.

### Cross-channel message posting

`slackChannel()` contributes `post_slack_message` by default:

```ts
post_slack_message({
  channelId: string,
  text: string,
  threadTs?: string,
});
```

Its executor calls the Slack API through `ctx.slack`, reusing the channel's bot
credentials and workspace binding, and returns an eve-owned result:

```ts
{
  channelId: string;
  messageTs: string;
  threadTs: string | null;
}
```

`SlackChannelConfig.tools` accepts the Part I async resolver. Slack merges its
bundled defaults first and applies the authored overlay second, so applications
can conditionally disable, replace, or extend the defaults:

```ts
export default slackChannel({
  async tools(ctx, { defineTool, disableTool }) {
    if (ctx.session.auth.current?.attributes.readOnly === true) {
      return { post_slack_message: disableTool() };
    }

    return {
      find_slack_user: defineTool({
        description: "Find a Slack user by email.",
        inputSchema: z.object({ email: z.string().email() }),
        execute: ({ email }, ctx) => ctx.slack.request("users.lookupByEmail", { email }),
      }),
    };
  },
});
```

The default is present when the application omits `tools`, returns `null`, or
does not mention `post_slack_message`.

### Staged file delivery

Slack also contributes `stage_file_upload`. The tool does not upload bytes
itself. It records a sandbox-relative path in durable Slack channel state, and
the final `message.completed` handler reads and attaches the file using the
same Slack binding that posts the answer.

The state is a queue rather than a single path so one turn can stage several
files. Entries carry the turn id to prevent an abandoned file from leaking into
a later answer and the tool call id to make replay an upsert rather than a
duplicate append:

```ts
interface SlackPendingUpload {
  id: string;
  turnId: string;
  path: string;
  filename: string;
}

interface SlackChannelState {
  // Existing fields omitted.
  pendingUploads: SlackPendingUpload[];
}
```

The channel authors the tool with the Part I API:

```ts
stage_file_upload: defineTool({
  description: "Attach a sandbox file to the final Slack response.",
  inputSchema: z.object({
    path: z.string(),
    filename: z.string(),
  }),
  execute({ path, filename }, ctx) {
    const pending = {
      id: ctx.callId,
      turnId: ctx.session.turn.id,
      path,
      filename,
    };
    const index = ctx.state.pendingUploads.findIndex((file) => file.id === ctx.callId);

    if (index === -1) ctx.state.pendingUploads.push(pending);
    else ctx.state.pendingUploads[index] = pending;

    return { staged: true, path, filename };
  },
}),
```

The Slack `message.completed` handler ignores intermediate completions that
request tools. On the final completion it loads this turn's paths from the live
sandbox, posts the message and files together, then removes only the entries it
successfully delivered:

```ts
async "message.completed"(data, channel, ctx) {
  if (data.finishReason === "tool-calls") return;

  const pending = channel.state.pendingUploads.filter(
    (file) => file.turnId === ctx.session.turn.id,
  );
  if (pending.length === 0) {
    await channel.thread.post(data.message);
    return;
  }

  const sandbox = await ctx.getSandbox();
  const files = await Promise.all(
    pending.map(async ({ path, filename }) => {
      const data = await sandbox.readBinaryFile({ path });
      if (data === null) throw new Error(`Staged file does not exist: ${path}`);
      return { data, filename };
    }),
  );

  await channel.thread.post({
    markdown: data.message,
    files,
  });

  const delivered = new Set(pending.map((file) => file.id));
  channel.state.pendingUploads = channel.state.pendingUploads.filter(
    (file) => !delivered.has(file.id),
  );
},
```

Only JSON metadata belongs in channel state; file bytes remain in the sandbox.
Paths are interpreted by `SandboxSession`, so relative paths resolve from
`/workspace` and no host filesystem path is persisted. The handler clears
entries only after Slack accepts the upload. Terminal `turn.failed` and
`turn.cancelled` handlers discard entries for that turn so abandoned paths do
not accumulate.

The bundled Slack default handler performs this drain. An application that
replaces `events["message.completed"]` assumes responsibility for posting the
answer and draining staged uploads, matching the existing replace-not-compose
event semantics. It may instead disable `stage_file_upload` through its tools
overlay.

### Slack validation and delivery

- Verify `post_slack_message` request mapping, inherited credentials, optional
  thread targeting, stable output, conditional disablement, and API errors
  without credential leakage.
- Verify one and multiple staged files, parallel tool calls, replay upserts,
  final-message-only delivery, missing files, successful cleanup, and terminal
  cleanup after failed or cancelled turns.
- Verify both tools are absent from non-Slack roots and delegated subagents,
  while proactive `receive(slack, ...)` sessions receive them.
- Update the Slack documentation and add a separate patch changeset for the
  Part II `eve` package change.
