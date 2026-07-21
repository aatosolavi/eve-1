---
issue: TBD
status: proposed
last_updated: "2026-07-20"
---

# Channel-scoped dynamic tools

## Summary

Channels need to contribute tools that exist only for turns running through
that channel. The tool set may depend on the current caller, channel state, or
an asynchronous policy check, and tool executors need the channel's live
context so they can reuse inherited credentials without serializing them.

Add an async, per-turn `tools` resolver to `defineChannel`. It returns a
record-keyed overlay of ordinary `defineTool(...)` definitions and
`disableTool()` sentinels. The resolver and its tool executors receive the
channel context returned by `context(...)`, in addition to their existing eve
context.

## Public authoring API

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

## Resolution and overlay semantics

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
with `ToolContext`. Executors should use that fresh context (for example,
`ctx.slack`) rather than capture API handles from the resolver. Credentials,
clients, and session handles never enter durable tool metadata.

Channel tools are available only to the root session whose active adapter owns
the resolver. They persist across follow-up turns on that channel and are
available when `receive(slack, ...)` starts a Slack-owned session. They do not
propagate into delegated subagents, schedules, HTTP sessions, or sessions on a
different channel.

## Slack default

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

`SlackChannelConfig.tools` accepts the same async resolver. Slack merges its
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

## Implementation boundaries

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

## Validation

- Type tests cover schema inference, resolver and executor access to custom
  channel context, protected context fields, and ordinary tools remaining
  limited to `ToolContext`.
- Runtime tests cover async caller-based resolution, add/replace/disable
  overlays, precedence over step-dynamic tools, resolver failure, and a new
  overlay on the next turn.
- Durability tests prove replay does not rerun the resolver, inline closure data
  survives, and live clients or credentials are never serialized.
- Scope tests cover Slack and custom-channel roots, follow-up turns,
  cross-channel receive, and absence from other channels and subagents.
- Slack tests cover the default request and stable result, inherited
  credentials, optional thread targeting, conditional disablement, custom
  additions, and API failures without credential leakage.
- Update the custom channel, Slack, dynamic capabilities, and TypeScript API
  documentation, and include a patch changeset for the published `eve` package.
