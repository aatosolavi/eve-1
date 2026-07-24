---
issue: https://github.com/vercel/eve/issues/1084
status: proposed
last_updated: "2026-07-24"
---

# Background tasks

## Summary

Every action the model takes that outlives its harness step becomes a
**task**: a durable record aligned with the MCP Tasks extension
(`io.modelcontextprotocol/tasks`, [SEP-2663]) — lifecycle
`working | input_required | completed | failed | cancelled`, receiver-minted
task ids, `tasks/get` / `tasks/update` / `tasks/cancel` operation semantics.
Whether a task blocks is a property of the **invocation**, not the task:

- **Sync** (today's behavior, unchanged): the step awaits the tool result,
  keeping the turn active.
  Until it arrives the session cannot move forward — unless it is steered,
  which dismisses the in-flight execution.
- **Background** (async, new): the tool call gets an immediate placeholder
  tool result (shaped like `CreateTaskResult`) telling the model the real
  result will arrive later. The turn ends normally and the session parks.
  When the task's status changes, a **notification** re-enters the session as
  input — a local hook resume or an HTTP callback, like any other delivery.

_Election_ is the per-call decision of whether a tool call runs synchronously
— the turn stays active awaiting the result, today's only behavior — or
detaches as a background task. Any tool is electable, including subagents
([Slice 2]) and authored tools ([Slice 3]). eve aligns on the extension's
_shapes and semantics_, not its wire protocol: tasks moved out of MCP core in
the 2026-07-28 release ([SEP-2663], superseding the experimental 2025-11-25
core feature), and the extension is itself experimental — so eve owns the
record and treats MCP wire exposure as a future adapter over an
already-isomorphic contract.

Due to its remote-agent architecture, eve plays both roles of the task
contract — the **caller** (MCP client): a session that dispatches work and
subscribes to the task; and the **callee** (MCP server): the executor that
runs it and emits status notifications. The spec is organized around that
split: a role-agnostic [contract](#contract) both sides read, then one
protocol section — with its own sequence diagram — per role
([caller protocol], [callee protocol]). Subagents compose the two: the
parent session is a caller, the child executor a callee, and consumer
registration is the handoff between the two protocols.

**Design goal — subagents are authored on the public primitives.** The
`agent` tool must be expressible as a plain `defineTool` over the surfaces
this plan ships; it gets no permanently private plumbing. That forces three
capabilities into the authoring contract rather than the internals:
**detachable execution** (an `execute` may hand its work to an external
executor and let a later callback resolve the task), **consumer
registration** (a detached executor attaches the caller's event consumer to
work it dispatches), and a **task handle** in the execution
context (read the record, set `statusMessage`). [Slice 2] migrates subagents
onto the record through internal plumbing; [Slice 3] promotes that plumbing
into the authoring surface and re-expresses the `agent` tool on it as the
reference implementation.

Delivery is three vertical slices, each cutting through both roles
end-to-end: (1) inert task mode — record creation plus the notification
return path, with no public electors; (2) subagents move onto the model;
(3) the public authoring API. Normalizing sync invocations onto the record
(a `mode: "sync" | "background"` discriminator) is [deferred](#deferred).

[SEP-2663]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663
[Slice 1]: #slice-1--inert-task-mode
[Slice 2]: #slice-2--subagents-on-the-task-model
[Slice 3]: #slice-3--the-public-authoring-api
[caller protocol]: #caller-protocol
[callee protocol]: #callee-protocol
[When a task is created]: #when-a-task-is-created

## Motivation

Two current behaviors block background execution:

1. **Results can only wake an active turn.** Subagent results resume the
   per-turn inbox hook, so `waitForRuntimeActionResults` must keep the parent
   turn active until every child resolves. Nothing can deliver work to a parked
   driver except a channel delivery: `waitForNextDeliver` skips every
   non-`deliver` hook payload.
2. **HITL requests either expire or block.** A pending question is cleared as
   `ignored` by the next unrelated message; a pending approval defers all
   subsequent input until answered. A response arriving after its request left
   `pendingInputs` is downgraded to plain text and never executes the original
   action ("a stale approval cannot authorize an earlier tool call",
   `src/harness/stale-input-responses.ts`).

Background tasks add the missing third state: work that neither keeps the
turn active nor gates the conversation, and whose completion re-enters the
session as input.

## What this unlocks

Capabilities that exist once the slices land, none of which are possible
today:

- **Fire-and-forget delegation** ([Slice 2]). A parent dispatches a subagent
  and keeps conversing; the turn ends with the work still running and the
  outcome re-enters as input. Today the parent turn is held open until every
  child resolves.
- **Subagent HITL reaches the parent without blocking it** ([Slice 2]).
  Today a child's question or approval reaches the user only through the
  turn-level proxy — which exists precisely because the parent turn is
  parked awaiting that child, so HITL propagation is coupled to the parent
  being blocked. A background child's `input_required` notification re-emits
  `input.requested` on the parent stream whether the parent is parked or
  mid-turn, the conversation keeps flowing, and the answer routes back
  through `updateTask`.
- **Child progress on the parent's surfaces** ([Slice 2]). Today the parent
  stream carries only `subagent.called` and `subagent.completed`; following
  a child means separately subscribing to its stream. Task notifications
  give the parent `statusMessage`-granularity progress: status transitions
  land on the parent stream as task lifecycle events, and passive consumers
  (a UI, a log sink) register with a filter for the full
  `task.created`/`task.progress` feed. Progress is per-transition, not a
  byte stream; the child's own stream remains the full-fidelity feed and
  stays independently subscribable.
- **Late answers execute** ([Slice 1]). A response whose request has left
  the turn that asked it routes to the live task via `updateTask` and the
  original action runs — instead of degrading to advisory text ("a stale
  approval cannot authorize an earlier tool call").
- **Executors without a session** ([Slice 3]). A detached authored tool
  hands work to an external system and resolves its task from a callback —
  the task contract stops being subagent-only and covers any long-running
  integration.

## Contract

Role-agnostic shapes and operations that both roles read. The record is the
single source of truth for status, pending input, and outcome; there is no
separate result-retrieval operation (the extension redesign removed blocking
`tasks/result`).

### The task record

A **task** is an identifiable container for an asynchronous, long-running
unit of work: a stable `taskId` plus the status, pending input, and outcome
of that work. A task exists only for background invocations; sync
invocations that resolve in-step materialize nothing (normalizing them onto
the record is [deferred](#deferred)). The record, in the extension's exact
shape:

```ts
type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

interface Task {
  readonly taskId: string; // minted, high-entropy; never a session id or token
  readonly status: TaskStatus;
  readonly statusMessage?: string;
  readonly createdAt: string; // ISO 8601
  readonly lastUpdatedAt: string; // ISO 8601
  readonly ttlMs: number | null; // null = unlimited retention
  readonly pollIntervalMs?: number;
}
```

Status-detailed variants mirror `DetailedTask` — a union discriminated on
`status` over the base record:

```ts
type DetailedTask =
  | (Task & { readonly status: "working" })
  | (Task & { readonly status: "input_required"; readonly inputRequests: readonly InputRequest[] })
  | (Task & { readonly status: "completed"; readonly result: JsonValue })
  | (Task & {
      readonly status: "failed";
      readonly error: { readonly message: string; readonly data?: JsonValue };
    })
  | (Task & { readonly status: "cancelled" });
```

- **`working`** — no extra payload; `statusMessage` is the only progress
  channel.
- **`input_required`** — carries its live `inputRequests`, eve's existing
  unified request shape (approvals and questions,
  `src/runtime/input/types.ts`); answers route through `updateTask` rather
  than the turn-scoped `pendingInputBatch` path.
- **`completed`** — `result` is the JSON output a sync invocation would have
  placed at the call position (`RuntimeToolResultActionResult.output` for
  tools; the structured subagent output in [Slice 2]).
- **`failed`** — `error` is created from an error-shaped tool result
  (`isError: true` → `message` from the output, original output preserved
  under `data`) or from an infrastructure failure. A failed task never
  carries `result`.
- **`cancelled`** — terminal with no outcome; set by `cancelTask` and sticky
  even if execution later runs to completion.

### Operations

Internal operations mirror the extension methods:

```ts
interface TaskService {
  getTask(taskId: string): Promise<DetailedTask>;
  updateTask(taskId: string, inputResponses: readonly InputResponse[]): Promise<DetailedTask>;
  cancelTask(taskId: string): Promise<DetailedTask>; // cooperative; resolves with status "cancelled"
}
```

Cancellation is cooperative and terminal states are final: once cancelled, a
task stays cancelled even if execution runs to completion.

The service is not framework-internal only — **agents get the same
operations** over their session's live tasks. The caller's model and
authored code can read a task (`getTask`), answer it (`updateTask`),
abort it (`cancelTask`), and **await** it — including a join across all
live tasks, so an agent fans out background work and blocks until every
task settles before composing the result. Awaiting is an invocation
posture, not a record property: the awaiting turn holds exactly like
today's sync wait and the record is untouched — background and sync stay
two postures over one task. The agent-facing surface ships with the
slice that owns it: model-facing task tools alongside [Slice 2]'s
electors, the authored handle with [Slice 3].

### The notification envelope

Every notification is an envelope: an explicit event kind plus the full
`DetailedTask` snapshot (mirroring `notifications/tasks` params, which carry
the whole record, not a delta — consumers never reconstruct state from event
history):

```ts
type TaskNotificationKind =
  | "task.created" // record created at background election
  | "task.progress" // statusMessage changed; status still "working"
  | "task.status" // non-terminal status transition (e.g. working → input_required)
  | "task.terminal"; // completed | failed | cancelled — outcome inline on the snapshot

interface TaskNotification {
  readonly kind: TaskNotificationKind;
  readonly task: DetailedTask;
}
```

A consumer of those notifications is a stored POST target:

```ts
interface EventConsumer {
  readonly url: string; // POST target, as /eve/v1/callback/:token today — local and remote alike
}
```

Which events land on a consumer is one opinionated default — a single place
to change, no per-consumer negotiation:

```ts
const DEFAULT_CONSUMER_EVENTS: readonly TaskNotificationKind[] = ["task.status", "task.terminal"]; // wake-worthy only
```

The default is deliberately narrow: v1's only registered consumer is the
caller's session driver, and a delivery wakes it (and may run a turn), so
progress chatter must not route there. A passive consumer (a UI, a log sink)
that wants the full feed — `task.created`, `task.progress` — gets it via a
per-consumer filter on registration overriding this default, not a new
mechanism.

Consumer URLs are capabilities (the token is embedded in the URL): they are
stored, never emitted on streams or surfaced to the model.

## Caller protocol

The caller is a session that dispatches work: it elects background, takes
the placeholder at the call position, registers its own wake consumer on the
task, and later routes the arriving notification back into itself.

```
caller — elect, park, wake, route

  session      turn       step        model           dispatch
     |           |          |            |                |
     |           |          |--invoke--->|                |
     |           |          |<-tool call-|                |
     |           |          |            |                |
     |           |          |----elect (task field)------>|   Task created; caller consumer registered
     |           |          |<-placeholder----------------|   CreateTaskResult at the call position
     |           |          |            |                |
     |           |          | step checkpoints            |   work keeps executing (callee)
     |           | turn ends (response)                   |
     | session parks (hook committed)                     |
     |                                                    |
     ~           ~          ~           ~                 ~
     |                                                    |
     |<---------TaskNotification (POST callback URL)------|
     |                                                    |
     | route step (latest deployment):                    |
     | ├─ terminal → run turn, outcome as input           |
     | └─ input_required → re-emit input.requested,       |
     |    park again (no turn)                            |
```

### When a task is created

A task is created at the moment the harness decides a tool call will not
resolve inside its step — never earlier (not at model emission) and never for
calls that resolve in-step. Only background invocations materialize a record
(the [deferred](#deferred) sync normalization extends it to sync invocations
with a `mode` discriminator). The decision point is the existing
runtime-action park path — steps 1 and 2 below are today's behavior,
unchanged by this plan:

1. The step epilogue collects the model's tool calls: calls whose definition
   carries a `runtimeAction` become the pending batch
   (`createRuntimeActionRequestFromToolCall`, `src/harness/tool-loop.ts`) and
   the step parks, storing the batch state — the action requests, the
   originating event metadata, and the model's response messages — on the
   session (`setPendingRuntimeActionBatch`, `src/harness/runtime-actions.ts`).
   Today this is where a subagent call leaves in-step execution.
2. The turn workflow dispatches the batch (`dispatchRuntimeActionsStep`) and
   — sync behavior — keeps the turn active awaiting every result
   (`waitForRuntimeActionResults`, `src/execution/turn-workflow.ts`).

Election is read between those two points, from the already-validated tool
input: presence of the `task` field on the call (gated by the tool's `task:`
declaration, [Slice 2]/[Slice 3]) selects background. On election the
dispatch step creates the `Task`, fills the call position with the
`CreateTaskResult` placeholder, and does **not** register the action key with
the in-turn wait — so the turn can end with the work still running. In-step
authored tools ([Slice 3]) elect at the same epilogue: an elected call is
routed into the dispatch path instead of in-step execution
(`src/harness/execute-tool.ts`).

On a background election the harness fills the tool-call position immediately
— the model sees a flat `CreateTaskResult` analog in place of the tool
result:

```json
{ "taskId": "…", "status": "working", "createdAt": "…", "lastUpdatedAt": "…", "ttlMs": null }
```

The turn then proceeds and may end with tasks still live. Each record is
owned by a dedicated durable **task run** — a single-writer actor: every
write is a command resumed onto the run's hook, applied under the
transition legality rules, and appended as a full snapshot to the run's
own stream; readers tail-read that stream cross-run. Session state cannot
own the record — it is threaded through step results, while transitions
must be writable from paths that hold no threadable state (the routing
step while the session is parked, the callback route, a detached
executor). The caller keeps only a live-task index (`taskId → task run`)
on session state; its two writers — election and terminal consumption —
sit on the threaded path. The recorded election likewise rides the
pending action batch rather than the action request, whose type is part
of the extension capability contracts.

### Consumer registration

At background dispatch, the caller registers its **session entry point** as a
consumer — a hook URL keyed by the public continuation token, targeting the
session's driver rather than any turn hook — on the child task. Consumers are
handed to the task at creation and live on its record, delivery state
included; the caller's own bookkeeping is the session-state live-task index.
One inert-mode edge: the registered URL embeds the continuation token current
at election, so token rotation orphans the consumer — the notify guard marks
it dead and drops. A session-stable callback alias is a [Slice 2] concern.

Registration is framework-internal through [Slice 2]: the only writer is
background dispatch itself. [Slice 3] exposes registration to authored
detached executors (required by the design goal); whether channels or
external callers ever get to add consumers is open question 4.

### Receiving notifications

A notification arriving at a parked session enters as a system-authored
`deliver` payload carrying the `TaskNotification` envelope. The pinned driver
body is untouched: discrimination happens in the routing step
(`routeDeliverToChildren` / `routeProxiedDeliverStep`), which runs at the
latest deployment. Routing outcomes reuse the driver's two existing arms:

- **terminal task** (`completed`/`failed`/`cancelled`, outcome inline on the
  record) → returned as the parent-local remainder; the driver runs a turn
  with the task outcome as input.
- **`input_required` task** (its `inputRequests` inline on the record) →
  fully consumed by the routing step (remainder `undefined`, the existing
  no-turn `continue` arm): the requests are re-emitted on the parent stream
  as `input.requested`, structurally, without waking the model — the
  driver-level analog of today's turn-level HITL proxy (when a subagent asks
  the user a question, the parent re-emits it upward as its own
  `input.requested` and relays the answer back down).

Task deliveries are stamped with the session's **initiator** auth
(`SessionAuthContext.initiator`), so the re-alived session runs under the
principal that started it, and cross-principal task deliveries are rejected
at routing.

### Scenario: a task notification lands mid-turn

Buffer-then-route: a notification never preempts a running turn, and mid-turn
arrival changes _when_ routing runs, never its outcome. A message that lands
while a turn is live follows the existing buffered-delivery machinery:

- Default: the message stays unread on the session delivery hook until the
  turn settles; the driver drains the buffer first, in arrival order
  (`waitForNextDeliver`), and the two arms above apply exactly as if the
  session had been parked.
- If the turn can't settle on its own — it's paused inside a subagent tool
  call that is itself waiting on a user answer — buffering would deadlock:
  the answer arrives as a delivery. The driver instead forwards deliveries
  into the live turn (the `turn-delivery-request` handshake), and turn-side
  routing runs the same discrimination:
  `input_required` is consumed in place (re-emitted as `input.requested`, the
  running turn unaffected); a terminal outcome is never injected into the
  live model conversation — it joins the turn's buffered remainders and
  re-enters as the next turn's input (invariant 1).
- Buffered messages coalesce at drain (`coalesceDeliveries`), so
  discrimination is per payload: a task notification coalesced with a public
  message splits at routing — the task payload resolves in the routing step,
  and the public remainder is what runs the turn.

### Late responses

Late responses are `tasks/update` semantics: at step 0, before stale
conversion, responses are checked against live tasks —
`requestId ∈ tasks(input_required).inputRequests` →
`updateTask(taskId, inputResponses)`; the action resumes outside any model
step and its outcome returns as a task notification. Otherwise today's stale
path applies unchanged.

## Callee protocol

The callee is the executor: it runs the work, transitions the record, and
emits a notification per transition to the task's registered consumers.

```
callee — run, transition, notify

  executor            task record            registered consumers
     |                     |                          |
     |----run work-------->|                          |
     |                     |                          |
     |--status change----->| working → input_required |
     |                     |--notify(kind, snapshot)->|   routed kinds only
     |                     |                          |   (default: status, terminal)
     |--statusMessage----->| task.progress            |   not routed by default
     |                     |                          |
     |--terminal outcome-->| completed|failed|cancelled
     |                     |--task.terminal---------->|   outcome inline on snapshot
     |                     |                          |
     |                     | per-consumer guard: gone consumer →
     |                     | mark dead, drop, no retry
```

Notifications are the return path: how an executor reaches back into the
caller agent's session when the result has no turn to return into — the
session is parked. This is the eve analog of the extension's task
subscriptions (`taskIds` subscribe/ack), but push-based, because a parked
session holds no connection to poll or be notified on. Completion resumes
the caller either:

- **sync**: while the caller turn is still parked, via its turn inbox hook
  (`resumeHook(parentContinuationToken, …)`);
- **async**: after the turn is gone, via an HTTP POST to the caller's
  session-driver callback URL — always, even when caller and callee share a
  deployment. Local delivery pays a loopback POST; that is the price of a
  single delivery path with no local/remote branch to keep in sync.

> Sidenote: this mechanism already exists for subagents reporting completion —
> `notifyDelegatedParentStep` resumes the parent via
> `resumeHook(parentContinuationToken, …)` — but that token is the parent
> _turn's_ inbox hook (`turn-workflow.ts`), so it only works while the parent
> turn is still live and parked awaiting the result. The consumers here must
> instead target the session's driver, which outlives any turn.

> Sidenote 2: _remote_ subagents already use the HTTP transport — dispatch
> hands the callee a URL minted from the parent turn's continuation token
> (`remote-agent-dispatch.ts`), the callee POSTs its terminal result to
> `/eve/v1/callback/:token`, and the route handler just does
> `resumeHook(token, …)` (`session-callback-route.ts`). So the consumer
> delivery below is proven wire plumbing; what changes is only the token's
> target —
> driver instead of turn hook — and that the callee may POST per
> transition, not once at terminal.

While a task is `working`, progress is `statusMessage` granularity per
transition, not a byte stream.

The notify step fans out one delivery per routed consumer per event,
guarding each independently: a token-not-found response from the callback
route (`HookNotFoundError` behind it) means that consumer is gone — mark it
dead, drop, no retry loop.

The remote-agent callback contract that already exists
(`callback: { token, url }` in `remote-agent-dispatch.ts`) is no longer a
special case at all — it is the one delivery path, generalized.

## Delivery

Three vertical slices. Each slice cuts through both protocols — caller and
callee behavior ship together, end-to-end — rather than layering contracts
horizontally.

### Slice 1 — inert task mode

The contract and both protocols land end-to-end with no public electors: the
record, transitions, and placeholder projection (caller); the notification
envelope, consumer storage, and guarded fan-out (callee); and the wiring — a
task status transition notifies its registered consumers, and a parked
session wakes, routes the two arms, and handles the mid-turn and
late-response scenarios. Nothing user-facing elects background yet; the
creation path is exercised internally, with unit and integration coverage
only.

### Slice 2 — subagents on the task model

Subagents are the first background electors: they already run out-of-step
(the runtime-action park path in [When a task is created]), so backgrounding
them changes only who awaits, not how they execute. This slice wires them
through the internal task plumbing directly; per the design goal that
privileged path is transitional — [Slice 3] promotes it into the authoring
surface and the `agent` tool is re-expressed on it.

Election is declared with a `task` combinator on `defineAgent` — the same
surface [Slice 3] later generalizes to `defineTool()`. Each combinator is
sugar for a plain config object carrying the 2025-11-25 `taskSupport`
semantics (the extension draft has not yet respecified request-side
negotiation) — the declaration site names **who decides**:

- `sync()` ↔ `taskSupport: "forbidden"` — sync only; no schema or behavior
  change. **Default when absent.**
- `defer()` ↔ `"optional"` — the model may elect background per call.
- `background()` ↔ `"required"` — every call is background.

When the declaration is not `sync()`, the agent-call input schema gains the
optional `task` field (`{ message, outputSchema?, task?: { ttlMs? } }`);
presence elects background. The task record maps `taskId → childSessionId`
internally. Sync subagent calls keep today's observable behavior unchanged
(turn parks, result at call position,
`subagent.called`/`subagent.completed` events); they move onto the task
record only when the [deferred](#deferred) sync normalization lands.

Background-specific semantics:

- Parent **turn** cancellation no longer implies task cancellation:
  background tasks are session-scoped. Sync children keep today's
  cancel-with-turn behavior.
- Session **done** with live tasks: the driver issues `cancelTask`
  (cooperative, abort-propagating via the existing descendant-cancel
  machinery) before finalizing. Task-mode (subagent) sessions may not
  finalize with live background tasks of their own: cancel-then-finalize.
- Background invocations emit task lifecycle events on the parent stream:
  `task.created`, `task.updated` (status transitions, including
  `input_required`), `task.completed` (terminal, with the `DetailedTask`
  outcome).

### Slice 3 — the public authoring API

The `task:` combinator surface from [Slice 2] generalizes to authored tools:

```ts
export default defineTool({
  // …
  task: defer(), // the model may elect background per call
});
```

Same combinators, same schema augmentation
(`{ …toolInput, task?: { ttlMs?: number } }`), same election point — an
elected call is routed into the dispatch path instead of in-step execution
([When a task is created]).

Election alone does not satisfy the design goal — an authored tool must also
be able to _be_ the kind of executor a subagent is. This slice therefore
promotes the three primitives the `agent` tool consumes (exact names are a
sketch; shapes and semantics are the commitment):

- **Task handle** — an elected call's execution context carries `ctx.task`:
  the `taskId`, a `getTask()` view of the record, and `setStatusMessage()`,
  which emits `task.progress`.
- **Detachable execution** — `ctx.task.detach()` returns a callback endpoint
  and lets `execute` return without resolving the task; the task completes
  when the external executor posts its terminal result to that endpoint.
  This is the authored form of the ownership transfer `runtimeAction`
  performs internally for subagents today.
- **Consumer registration** — a detached executor may register the task's
  event consumers on work it dispatches (the same capability background
  dispatch uses in [Slice 1]), so forwarded notifications need no private
  path.

The exit criterion is the dogfooding test: the `agent` tool re-implemented
as a `defineTool` on these primitives, behavior-identical to the [Slice 2]
migration, and the privileged internal path deleted.

Sync-by-default is deliberate but transitional. Model election over a tool
whose author never considered backgrounding is not obviously safe (a
fire-and-forget election on a non-idempotent tool), and the `task` input
field costs schema tokens on every declared tool. We want to move to
`defer()` as the default once that safety story is settled (open question 6).

`ttlMs` expiry resolves an unresolved `input_required` task the way `ignored`
resolves questions today.

## Invariants

1. A background result never completes its originating tool-call part; the
   call position is terminalized at election with the `CreateTaskResult`
   placeholder and the outcome enters as new input. (Provider contract:
   dangling tool calls must resolve before the conversation continues;
   history is append-only.)
2. The driver's wake vocabulary stays `deliver`-only and the
   `NextDriverAction` contract stays closed; all new discrimination lives in
   step bodies.
3. Task ids are minted; continuation tokens, consumer tokens, and child
   session ids never appear as task ids or on streams.
4. Task deliveries execute under the session's initiator principal; tasks are
   bound to the auth context that created them.
5. Every notification send is guarded per consumer; a gone consumer never
   fails the task or triggers retry loops.

## Deferred

- **Sync invocations on the task record.** The record grows a
  `mode: "sync" | "background"` discriminator and sync tool and subagent
  calls are expressed as tasks too — same record, same transitions, same
  lifecycle events — with the invocation mode reduced to **who awaits**: a
  `sync` task is awaited at turn scope (the `waitForRuntimeActionResults`
  hold, keyed by `taskId` instead of bespoke action keys), a `background`
  task is not. This buys `getTask`/`updateTask`/`cancelTask`, HITL routing,
  lifecycle events, and observability on one interface regardless of mode —
  no parallel code paths for "a subagent the turn is waiting on" versus "a
  subagent running in the background". Observable sync behavior is
  unchanged; it is purely internal normalization, so it ships whenever the
  parallel paths start to hurt rather than as one of the slices above.
- **Token-budget accounting** for detached work (fan-out currently splits the
  parent's remaining quota at dispatch; late-arriving usage attribution is
  out of scope here).
- **MCP wire exposure** (eve as MCP server speaking the tasks extension).
  The record and operations are kept isomorphic so this is an adapter, not a
  redesign.
- **Root HITL as tasks** (non-blocking approvals with `ttlMs` replacing the
  block/expire split) — the record supports it; changing approval gating is a
  separate, security-sensitive decision.

## Open questions

1. Should subagents default to `defer()` rather than `sync()`? Conservative
   default preserves all current behavior until authors opt in.
2. Agents get the task operations, cancel and await included
   ([Operations](#operations)); open is the model-facing shape — built-in
   tools (`cancel_task`, `await_task`) versus surfacing them only through
   authored code — and whether await-all is a first-class barrier or
   composes from per-task awaits.
3. When a background child goes `input_required` and the user answers in the
   parent conversation, does the answer route by `requestId` alone (today's
   proxy map semantics) or also require the task to still be live under its
   `ttlMs`?
4. Authored detached executors register consumers as of [Slice 3] (design
   goal). Still open: do channels or external callers ever get to add
   consumers, and what ordering or dedup guarantee does a consumer get when
   transitions burst?
5. The extension draft is experimental and has not finalized request-side
   augmentation or `taskSupport`; when it does, does eve chase the final
   names or freeze on the 2025-11-25 semantics until the wire adapter forces
   the question?
6. Flipping the default from `sync()` to `defer()`: what makes model
   election safe for arbitrary tools (placeholder + notification path on
   non-idempotent operations), and is the per-tool schema cost of the `task`
   field acceptable across the board? Related: does `background()` grow a
   conditional form (`background({ cond })`), and is `cond` an args predicate
   at dispatch or a runtime promotion after a time threshold?

## Appendix — MCP alignment

Shapes and semantics follow the [ext-tasks draft schema]. Transport differs
by necessity — eve sessions park without holding connections — and the
extension has not yet specified request-side augmentation or `taskSupport`,
where eve anchors on the 2025-11-25 core feature those drafts inherit from.

| Surface                               | MCP tasks extension                                                                                              | eve                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Task object                           | `taskId, status, statusMessage?, createdAt, lastUpdatedAt, ttlMs (nullable), pollIntervalMs?`                    | identical record shape                                                           |
| Status detail                         | `DetailedTask`: `input_required` carries `inputRequests`; `completed` carries `result`; `failed` carries `error` | identical; replaces any separate result-retrieval call                           |
| Create                                | `CreateTaskResult = Result & Task` returned in place of the operation result                                     | the placeholder tool result at the call position                                 |
| `tasks/get`                           | poll one task → `DetailedTask`                                                                                   | internal `getTask(taskId)`; wire adapter later                                   |
| `tasks/update`                        | `{ taskId, inputResponses }` → ack                                                                               | step-0 routing of late responses to live `input_required` tasks                  |
| `tasks/cancel`                        | ack; "cooperative and eventually consistent"                                                                     | best-effort abort propagation via descendant-cancel machinery                    |
| `notifications/tasks`                 | params = full `DetailedTask`                                                                                     | `TaskNotification` envelope (kind + full `DetailedTask`) to each routed consumer |
| Subscriptions                         | subscribe/ack notifications with `taskIds?: string[]`                                                            | consumer registration on the task (caller protocol, [Slice 1])                   |
| `tasks/list`, blocking `tasks/result` | removed by the extension redesign                                                                                | not built                                                                        |
| Task augmentation, `taskSupport`      | not yet in the extension draft                                                                                   | `task` input field + `task:` combinators over 2025-11-25 `taskSupport`           |

[ext-tasks draft schema]: https://github.com/modelcontextprotocol/ext-tasks
