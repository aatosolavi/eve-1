---
issue: https://github.com/vercel/eve/issues/512
last_updated: "2026-07-10"
status: proposed
---

# Decouple eve's agent loop from durable execution

## Decision

Adopt two eve-owned domain programs, `runSession` and `runTurn`, over one
internal `LoopBackend` execution port. The port has typed generation and tool
methods, handle-returning turn and session spawns, and an owned event stream.

Three executable adapters validate this boundary: inline JavaScript, Workflow
DevKit, and Temporal. All run the same programs and nine-test conformance
suite. This validates the program/adapter split; it does not yet validate a
production migration. The remaining gates are listed below rather than hidden
behind the interface.

Workflow remains the default durable backend because it is already integrated
with eve's compiler, host, and public stream. Inline becomes the reference
non-durable interpreter. Temporal is a feasible optional backend, not a
drop-in replacement.

## Why the current boundary is insufficient

Today the loop is distributed across four execution levels:

```text
workflow-runtime
  -> workflowEntry             session lifetime and public input
     -> turnWorkflow           one logical turn and local child waits
        -> turnStep            model, tools, events, snapshot commit
           -> tool-loop        generation and request handling
```

The host surface starts in
[`workflow-runtime.ts`](../packages/eve/src/execution/workflow-runtime.ts), the
session driver lives in
[`workflow-entry.ts`](../packages/eve/src/execution/workflow-entry.ts), turns
run through [`turn-workflow.ts`](../packages/eve/src/execution/turn-workflow.ts),
and [`workflow-steps.ts`](../packages/eve/src/execution/workflow-steps.ts)
rehydrates and commits state. Model calls, ordinary tool side effects, adapter
callbacks, and event writes occur before the step result commits. The code
therefore establishes ordering, not one transaction across effects and state.

The current split also threads both `DurableSessionState` and
`serializedContext` through the durable boundary. Any replacement needs one
explicit commit rule, not another layer that keeps the two cursors implicit.

## Ownership

```text
PrototypeRuntime                 test-facing run controller
  -> adapter                     engine mechanics
     -> runSession               session domain transitions
        -> spawnTurn().wait()
           -> runTurn            turn domain transitions
              -> parent Stream   borrowed handle
              -> spawnChild()    fresh child Stream
     -> checkpoint protocol      revisions, lease, relay, acknowledgement
```

- `runSession` owns session lifetime, public input, turn dispatch, buffering,
  and the public terminal result.
- `runTurn` owns generation, eve-executed tools, approvals, subagents, balanced
  history, and the logical result of one turn.
- `LoopBackend` exposes only the execution operations those programs require.
  It contains no `step`, `Activity`, `Hook`, or `Signal` vocabulary.
- An adapter owns engine-specific child startup, suspension, checkpoint relay,
  acknowledgement, retry, stream binding, lifecycle persistence, and
  serialization.
- The prototype service supplies scripted effects and the canonical event
  store. It is test infrastructure, not part of the proposed public API.

The executable contract is the source of truth in
[`types.ts`](../packages/eve/src/internal/testing/loop-prototype/types.ts).
The port surface is reproduced verbatim below; `SessionState` and the
input/outcome payload types are not copied because abbreviated duplicates
would drift.

## Contract decisions

### The port at a glance

The two programs are plain async functions over one closed port:

```ts
runSession(backend: LoopBackend, input: SessionProgramInput): Promise<TerminalOutcome>;
runTurn(backend: LoopBackend, input: TurnProgramInput): Promise<TurnOutcome>;
```

Everything the loop can do is enumerable on `LoopBackend`:

```ts
interface LoopBackend {
  readonly executionId: ExecutionId;
  readonly stream: Stream;

  checkpoint(state: SessionState): Promise<void>;
  executeTool(request: ApprovalRequest | ToolRequest): Promise<RequestResult>;
  finish(outcome: TerminalOutcome): Promise<void>;
  generate(input: GenerateInput): Promise<GeneratedTurn>;
  receive(): Promise<Delivery>;
  spawnChild(input: DelegatedSessionInput): ChildHandle;
  spawnTurn(input: TurnProgramInput): TurnHandle;
}

interface Stream {
  append(event: StreamEvent): Promise<void>;
}

interface TurnHandle {
  readonly id: ChildId;
  wait(): Promise<TurnOutcome>;
}

interface ChildHandle {
  readonly id: ChildId;
  wait(): Promise<TerminalOutcome>;
}
```

Operation identity, retry policy, checkpoint relay, acknowledgement, lease
validation, event-log identity, sequence assignment, and backend run identity
all live below this line, inside adapters and the shared support modules.

### Checkpoint relay is below the port

The programs call `checkpoint(state)` and never exchange revisions, leases, or
acknowledgements. Each turn handle owns a shared `TurnCheckpointProtocol`
([`checkpoint-protocol.ts`](../packages/eve/src/internal/testing/loop-prototype/checkpoint-protocol.ts))
that validates parent-owned identity, monotonic revisions, exact redelivery,
lease return, and terminal byte equality. The adapter persists each accepted update
before acknowledging it and completes the lease return before `wait()`
resolves.

This remains a protocol lease, not a distributed lock. The prototype has no
expiry or compare-and-swap store. Workflow and Temporal history record program
progress; inline retains it only in memory.

### Spawns return typed handles

`spawnTurn(input)` returns a `TurnHandle`; `spawnChild(input)` returns a
`ChildHandle`. Both expose the logical child ID immediately and put completion
behind `wait()`. Backend run identity stays inside the adapter. The distinct
handle types preserve child kind without a generic notice union or overloaded
wait operation.

Stream ownership is structural. A turn backend receives the same `Stream`
handle as its parent. A delegated session backend receives a new stream. The
programs no longer pass `borrow-parent` or `own` descriptors, log IDs, or event
sequences. Each stream binds its log identity, and the event store assigns the
next sequence while deduplicating by event ID.

### Effects are typed and retry-aware

The loop-visible effects are `generate(input): Promise<GeneratedTurn>` and
`executeTool(request): Promise<RequestResult>`. Their definitions in
[`effect-definitions.ts`](../packages/eve/src/internal/testing/loop-prototype/effect-definitions.ts)
declare the operation-ID rule and retry/idempotency policy once, and the
conformance suite derives operation IDs from that same module. The adapters may
translate those calls into a wire `EffectCall`, but the programs never
construct transport names, operation IDs, or retry policies.

Input delivery is `receive()`, not an effect. Session initialization happens
when the adapter starts the session. `finish(outcome)` verifies terminal state,
records the callback, and publishes the terminal event. Declared effect
exhaustion becomes a typed turn failure; ledger, codec, and engine failures
still throw.

The ambiguous-completion test commits an effect result before injecting
response loss. Durable adapters make a second attempt but return the committed
result without executing the effect again. Real effect integrations must
provide the same idempotency boundary; an engine retry policy alone cannot.

### Provider history stays balanced

An assistant response with unresolved local requests lives in `OpenExchange`,
outside `BalancedHistory`. It enters provider history only after every request
has a terminal result. Unrelated input received during approval is buffered for
the next turn rather than treated as denial.

### Domain status is not engine status

When `finish(outcome)` succeeds, one `TerminalOutcome` value drives eve's
terminal event, callback, parent result, and public result. A domain-level
failed outcome may be returned by a successfully completed Workflow or Temporal
execution. Protocol and infrastructure errors throw and fail the engine
execution. Publication across those surfaces is ordered but not atomic; that is
a production gate below.

## Backend assessment

| Adapter  | What the prototype establishes                                                                        | Production consequence                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Inline   | Direct program execution, one attempt, process-local queues and events, deliberate state loss         | Reference interpreter and optional explicitly non-durable path                                |
| Workflow | Real local World, steps, Hooks, child runs, checkpoint acknowledgement, and native writable mirroring | Smallest migration; compiler, host routes, cleanup, and stream semantics remain adapter-owned |
| Temporal | Real local server and Worker, Activities, Signals, Child Workflows, and history inspection            | Requires an eve event store, Worker hosting, routing, and codec policy                        |

Workflow and Temporal can recover program history as engine capabilities. The
prototype does not claim a kill-and-restart recovery test.

## Preserved semantics

- A conversation replies and parks; a task returns a terminal result.
- Each new turn may resolve current code while the long-lived session remains
  pinned to a compatible contract.
- A turn writes the session event log; a subagent owns an independent log.
- Child IDs are observable before results, and results retain request order.
- Human waits never commit an unresolved tool request into provider history.
- Public input unrelated to a pending approval remains available to a later
  turn.
- Reader cancellation is not silently redefined as session cancellation.

These are requirements for the migration. The prototypes exercise the subset
listed in the [dated evidence record](./loop-interface-prototype-results.md).

## Production gates

1. **Delivery claim and rekey.** Port the existing claim, accept, cancel,
   release, retired-hook drain, and continuation-token rekey races. The
   prototypes intentionally use a fixed public address.
2. **Terminal publication and live stream atomicity.** Choose an authoritative
   event store and either an idempotent outbox or a documented at-least-once
   publication contract for events, callback, result, and stream mirrors.
   Workflow's prototype SQLite append and native writable write are not one
   transaction.
3. **Cross-deployment codec.** Parse and version every Hook, Signal, Activity,
   and child boundary. The standalone codec unit test is not adapter adoption.
4. **Version routing.** Prove pinned-session/latest-turn behavior against real
   Vercel deployments and
   [Temporal Worker Deployments](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning).
   Local intent metadata is not routing evidence.
5. **Cancellation and cleanup.** Define graceful session cancellation and prove
   descendant cleanup. Workflow child runs started from steps can otherwise
   outlive a canceled root.
6. **Approval batches.** Either keep the prototype's restriction of one
   approval-only unresolved batch or define ordered resumable mixed batches.
7. **Real effect idempotency.** Establish provider/tool behavior when an
   external call succeeds but eve loses the response before committing it.
8. **Workflow child-start idempotency.** Deduplicate child creation by logical
   child ID when `start()` succeeds but its enclosing step loses the result. A
   retryable start step without a backend idempotency key can orphan a duplicate
   run.
9. **Build and host selection.** Package the eve-owned programs and selected
   adapters, then prove that compiler output, session callbacks, schedules, and
   runtime routes select a backend without importing Workflow mechanics
   directly. Prototype code under `internal/testing` is intentionally excluded
   from the published build.
10. **Crash recovery.** Kill and restart a Worker while a session is parked and
    while an effect response is ambiguous. Prove that the same logical run,
    checkpoint, event sequence, and operation IDs resume without duplicated
    externally visible work.
11. **Private control delivery.** Give checkpoint, acknowledgement, and child
    settlement notifications stable operation identities and receiver-side
    deduplication. The Workflow prototype re-acknowledges identical checkpoints
    and treats a missing Hook on a retried send as ambiguous success; that is a
    local mechanism, not a production exactly-once proof.

## Migration

1. Land the shared programs and inline adapter as internal code and keep the
   contract closed.
2. Put current Workflow mechanics behind the adapter without changing public
   delivery, callback, stream, or deployment behavior.
3. Move the chosen adapters into the published build and route compiler and
   host entry points through explicit backend selection.
4. Add adversarial tests for every production gate before deleting the current
   driver protocols.
5. Migrate callers to explicit turn/session child operations and delete the old
   generic abstraction in the same wave; eve is pre-1.0, so no legacy fallback
   is justified.
6. Treat Temporal as a later product and operations decision after event-store,
   hosting, versioning, and codec ownership are explicit.

The decision criteria are semantic equivalence, reader load, then operational
cost. That ordering keeps the core small without pretending backend mechanics
have disappeared.
