---
issue: https://github.com/vercel/eve/issues/1084
status: proposed
last_updated: "2026-07-22"
---

# Background tasks

## Summary

Every action the model takes that outlives its harness step becomes a
**task**: a durable record aligned with the MCP Tasks extension
(`io.modelcontextprotocol/tasks`, [SEP-2663]) — lifecycle
`working | input_required | completed | failed | cancelled`, receiver-minted
task ids, `tasks/get` / `tasks/update` / `tasks/cancel` operation semantics.
Whether a task blocks is a property of the **invocation**, not the task:

- **Sync** (today's behavior, unchanged): the turn parks until the result
  arrives and the result lands at its tool-call position in model history.
- **Background** (async, new): the tool-call position is terminalized
  immediately with a `CreateTaskResult`-shaped placeholder, the turn ends
  normally, and status transitions reach subscribers through
  **notifications** — deliveries to endpoints registered on the task.

Any tool is electable, including subagents. eve aligns on the extension's
_shapes and semantics_, not its wire protocol: tasks moved out of MCP core in
the 2026-07-28 release ([SEP-2663], superseding the experimental 2025-11-25
core feature), and the extension is itself experimental — so eve owns the
record and treats MCP wire exposure as a future adapter over an
already-isomorphic contract.

Delivery is five additive phases: (1) task contract, (2) notifications
contract, (3) wiring tasks to notifications, (4) `defineTool()` election,
(5) migrating the `agent` tool and subagents.

[SEP-2663]: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663

## Motivation

Two current behaviors block background execution:

1. **Results can only wake an open turn.** Subagent results resume the
   per-turn inbox hook, so `waitForRuntimeActionResults` must hold the parent
   turn open until every child resolves. Nothing can deliver work to a parked
   driver except a channel delivery: `waitForNextDeliver` skips every
   non-`deliver` hook payload.
2. **HITL requests either lapse or block.** A pending question is cleared as
   `ignored` by the next unrelated message; a pending approval defers all
   subsequent input until answered. A response arriving after its request left
   `pendingInputs` is downgraded to plain text and never executes the original
   action ("a stale approval cannot authorize an earlier tool call",
   `src/harness/stale-input-responses.ts`).

Background tasks add the missing third state: work that neither holds the
turn open nor gates the conversation, and whose completion re-enters the
session as input.

## MCP alignment

Shapes and semantics follow the [ext-tasks draft schema]. Transport differs
by necessity — eve sessions park without holding connections — and the
extension has not yet specified request-side augmentation or `taskSupport`,
where eve anchors on the 2025-11-25 core feature those drafts inherit from.

| Surface                               | MCP tasks extension                                                                                              | eve                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Task object                           | `taskId, status, statusMessage?, createdAt, lastUpdatedAt, ttlMs (nullable), pollIntervalMs?`                    | identical record shape                                                |
| Status detail                         | `DetailedTask`: `input_required` carries `inputRequests`; `completed` carries `result`; `failed` carries `error` | identical; replaces any separate result-retrieval call                |
| Create                                | `CreateTaskResult = Result & Task` returned in place of the operation result                                     | the placeholder tool result at the call position                      |
| `tasks/get`                           | poll one task → `DetailedTask`                                                                                   | internal `getTask(taskId)`; wire adapter later                        |
| `tasks/update`                        | `{ taskId, inputResponses }` → ack                                                                               | step-0 routing of late responses to live `input_required` tasks       |
| `tasks/cancel`                        | ack; "cooperative and eventually consistent"                                                                     | best-effort abort propagation via descendant-cancel machinery         |
| `notifications/tasks`                 | params = full `DetailedTask`                                                                                     | notification payload to each registered endpoint                      |
| Subscriptions                         | subscribe/ack notifications with `taskIds?: string[]`                                                            | endpoint registration on the task (phase 2)                           |
| `tasks/list`, blocking `tasks/result` | removed by the extension redesign                                                                                | not built                                                             |
| Task augmentation, `taskSupport`      | not yet in the extension draft                                                                                   | `task` input field + `execution.taskSupport` per 2025-11-25 semantics |

[ext-tasks draft schema]: https://github.com/modelcontextprotocol/ext-tasks

## Phase 1 — task contract

The record, minted only at park or detach (sync invocations that resolve
in-step materialize nothing), in the extension's exact shape:

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

Status-detailed variants mirror `DetailedTask`: `input_required` carries its
`inputRequests`, `completed` carries `result`, `failed` carries `error` — the
record is the single source of truth for status, pending input, and outcome;
there is no separate result-retrieval operation.

Internal operations mirror the extension methods: `getTask(taskId)`,
`updateTask(taskId, inputResponses)`, `cancelTask(taskId)` (cooperative;
terminal states are final; once cancelled, a task stays cancelled even if
execution runs to completion). A tool result with `isError` maps to `failed`.

On a background election the harness terminalizes the tool-call position
immediately — the model sees a flat `CreateTaskResult` analog in place of the
tool result:

```json
{ "taskId": "…", "status": "working", "createdAt": "…", "lastUpdatedAt": "…", "ttlMs": null }
```

The turn then proceeds and may end with tasks still live. Records live on the
durable session state (as `pendingInputBatch` does today) and ride the
existing step-result persistence boundary.

**Phase 1 has no users**: the record, transitions, and placeholder projection
land with unit coverage only; nothing elects background yet.

## Phase 2 — notifications contract

Notifications are **deliveries to registered endpoints** — eve's analog of
the extension's task subscriptions (`taskIds` subscribe/ack), with push
transport because parked sessions hold no connection to be notified on. An
agent stores its registered endpoints on durable state:

```ts
type NotificationEndpoint =
  | { readonly kind: "hook"; readonly token: string } // local: resumeHook(token, …)
  | { readonly kind: "http"; readonly url: string }; // remote: POST, as /eve/v1/callback/:token today
```

- Registration and storage are session-state operations; no new persistence.
- The notification payload is the full `DetailedTask` (mirroring
  `notifications/tasks` params).
- The notify step fans out one delivery per endpoint per transition, guarding
  each independently: `HookNotFoundError` (or the HTTP equivalent) means that
  subscriber is gone — mark the endpoint dead, drop, no retry loop.
- Endpoint tokens and URLs are capabilities: they are stored, never emitted
  on streams or surfaced to the model.

The remote-agent callback contract that already exists
(`callback: { token, url }` in `remote-agent-dispatch.ts`) becomes the
single-endpoint special case.

**Phase 2 has no producers yet**: the contract, storage, and fan-out step
land independently of tasks.

## Phase 3 — wiring tasks to notifications

Task status transitions notify the task's registered endpoints. The
parent-wake path is now just registration: at background dispatch, the parent
registers its **session entry point** (a hook endpoint keyed by the public
continuation token) on the child task.

A notification arriving at a parked session enters as a system-authored
`deliver` payload carrying the `DetailedTask`. The pinned driver body is
untouched: discrimination happens in the routing step
(`routeDeliverToChildren` / `routeProxiedDeliverStep`), which runs at the
latest deployment. Routing outcomes reuse the driver's two existing arms:

- **terminal task** (`completed`/`failed`/`cancelled`, outcome inline on the
  record) → returned as the parent-local remainder; the driver runs a turn
  with the task outcome as input.
- **`input_required` task** (its `inputRequests` inline on the record) →
  fully consumed by the routing step (remainder `undefined`, the existing
  no-turn `continue` arm): the requests are re-emitted on the parent stream
  as `input.requested`, structurally, without waking the model — the
  driver-level analog of today's turn-level subagent HITL proxy.

Task deliveries are stamped with the session's **initiator** auth
(`SessionAuthContext.initiator`), so the re-alived session runs under the
principal that started it, and cross-principal task deliveries are rejected
at routing.

```
model elects background          task executor                parked subscriber (parent)
        │                             │                              │
  CreateTaskResult placeholder   status transition                   │
  status: working ──────▶  notify(registered endpoints)              │
        │                    ├─ hook: deliver(token, DetailedTask) ─▶│ wake
   turn ends normally        └─ http: POST url            route step (latest)
                                                         ├─ terminal → run turn
                                                         └─ input_required →
                                                            emit + park (no turn)
```

Late responses are `tasks/update` semantics: at step 0, before stale
conversion, responses are checked against live tasks —
`requestId ∈ tasks(input_required).inputRequests` →
`updateTask(taskId, inputResponses)`; the action resumes outside any model
step and its outcome returns as a task notification. Otherwise today's stale
path applies unchanged.

## Phase 4 — `defineTool()` election

Tool definitions gain an execution declaration using the 2025-11-25
`taskSupport` semantics (the extension draft has not yet respecified
request-side negotiation):

```ts
export default defineTool({
  // …
  execution: { taskSupport: "optional" }, // "required" | "optional" | "forbidden"
});
```

- `"forbidden"` (default, and the default when absent): sync only. No schema
  or behavior change.
- `"optional"`: the model may elect background per call.
- `"required"`: every call is background.

When `taskSupport` is not `"forbidden"`, the tool's input schema gains an
optional `task` field mirroring task augmentation; presence elects
background:

```ts
{ …toolInput, task?: { ttlMs?: number } }
```

`ttlMs` expiry resolves an unresolved `input_required` task the way `ignored`
resolves questions today.

## Phase 5 — migrate the `agent` tool and subagents

The built-in `agent` tool and declared subagents move onto the task record
for both invocation modes:

- **Sync** subagent calls keep today's observable behavior (turn parks,
  result at call position, `subagent.called`/`subagent.completed` events) but
  are internally expressed as tasks awaited at turn scope.
- **Background** election uses the same `execution.taskSupport` declaration
  on `defineAgent` and the same `task` input field
  (`{ message, outputSchema?, task?: { ttlMs? } }`). The task record maps
  `taskId → childSessionId` internally.

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

## Invariants

1. A background result never completes its originating tool-call part; the
   call position is terminalized at election with the `CreateTaskResult`
   placeholder and the outcome enters as new input. (Provider contract:
   dangling tool calls must resolve before the conversation continues;
   history is append-only.)
2. The driver's wake vocabulary stays `deliver`-only and the
   `NextDriverAction` contract stays closed; all new discrimination lives in
   step bodies.
3. Task ids are minted; continuation tokens, endpoint tokens, and child
   session ids never appear as task ids or on streams.
4. Task deliveries execute under the session's initiator principal; tasks are
   bound to the auth context that created them.
5. Every notification send is guarded per endpoint; a gone subscriber never
   fails the task or triggers retry loops.

## Deferred

- **Token-budget accounting** for detached work (fan-out currently splits the
  parent's remaining quota at dispatch; late-arriving usage attribution is
  out of scope here).
- **MCP wire exposure** (eve as MCP server speaking the tasks extension).
  The record and operations are kept isomorphic so this is an adapter, not a
  redesign.
- **Root HITL as tasks** (non-blocking approvals with `ttlMs` replacing the
  block/lapse split) — the record supports it; changing approval gating is a
  separate, security-sensitive decision.

## Open questions

1. Should subagents default to `taskSupport: "optional"` rather than
   `"forbidden"`? Conservative default preserves all current behavior until
   authors opt in.
2. Does the parent model get a built-in `cancel_task` tool, or is
   cancellation channel/author-only in v1?
3. When a background child goes `input_required` and the user answers in the
   parent conversation, does the answer route by `requestId` alone (today's
   proxy map semantics) or also require the task to still be live under its
   `ttlMs`?
4. Who may register notification endpoints besides the framework itself at
   dispatch — authored code, channels, external callers? And what ordering or
   dedup guarantee does an endpoint get when transitions burst?
5. The extension draft is experimental and has not finalized request-side
   augmentation or `taskSupport`; when it does, does eve chase the final
   names or freeze on the 2025-11-25 semantics until the wire adapter forces
   the question?
