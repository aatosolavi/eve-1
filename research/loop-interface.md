---
issue: https://github.com/vercel/eve/issues/512
last_updated: "2026-07-20"
status: proposed
---

# Decouple eve's agent loop from durable execution

## Decision

Adopt two eve-owned domain programs, `runSession` and `runTurn`, over one
internal `LoopBackend` execution port. The port has typed generation and tool
methods, handle-returning turn and session spawns, and an owned event stream.
`runTurn` drives named loop phases — initiate, advance, settle — and delegates
each step's intra-turn work to `next(dependencies, input)`, where
`TurnDependencies` is the port slice a step is allowed to use.

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
PrototypeRuntime                       test-facing run controller
  -> adapter                           engine mechanics
     -> runSession                     session domain transitions
        -> spawnTurn().wait()
           -> runTurn                  turn loop mechanics: initiate, advance, settle
              -> next(dependencies)    one step: generate + resolve requests
                 -> parent Stream      borrowed handle
                 -> spawnChild()       fresh child Stream
     -> checkpoint protocol            revisions, lease, relay, acknowledgement
```

- `runSession` owns session lifetime, public input, turn dispatch, buffering,
  and the public terminal result.
- `runTurn` owns turn loop mechanics: folding the delivery into state, advancing
  steps, checkpointing, and mapping the final step onto the logical result of
  one turn.
- `next` owns one step of intra-turn work — generation, eve-executed tools,
  approvals, subagents, balanced history — expressed only against injected
  `TurnDependencies`.
- `LoopBackend` exposes only the execution operations those programs require.
  It contains no `Activity`, `Hook`, `Signal`, or engine-step vocabulary; the
  domain word "step" below names one loop iteration, never an engine primitive.
- An adapter owns engine-specific child startup, suspension, checkpoint relay,
  acknowledgement, retry, stream binding, lifecycle persistence, and
  serialization.
- The prototype service supplies scripted effects and the canonical event
  store. It is test infrastructure, not part of the proposed public API.

The prototype's directories mirror this ownership: `core/` holds the programs,
the step function, and the contract; `service/` holds the scripted effects and
event store; each adapter owns its directory; checkpoint protocol, wire codec,
and the conformance suite sit between them at the root.

The executable contract is the source of truth in
[`types.ts`](../packages/eve/src/internal/testing/loop-prototype/core/types.ts).
The port surface is reproduced verbatim below; `SessionState` and the
input/outcome payload types are not copied because abbreviated duplicates
would drift.

## Contract decisions

### The port at a glance

The two programs are plain async functions over one closed port, and the
intra-turn step function is a plain async function over the port's
turn-facing slice:

```ts
runSession(backend: LoopBackend, input: SessionProgramInput): Promise<TerminalOutcome>;
runTurn(backend: LoopBackend, input: TurnProgramInput): Promise<TurnOutcome>;
next(dependencies: TurnDependencies, input: StepInput): Promise<StepResult>;
```

Everything the loop can do is enumerable on `LoopBackend`, split into the
capabilities a step receives and the operations only the loop drivers see:

```ts
interface TurnDependencies {
  readonly stream: Stream;

  executeTool(request: ApprovalRequest | ToolRequest): Promise<RequestResult>;
  generate(input: GenerateInput): Promise<GeneratedTurn>;
  spawnChild(input: DelegatedSessionInput): ChildHandle;
}

interface LoopBackend extends TurnDependencies {
  readonly executionId: ExecutionId;

  checkpoint(state: SessionState): Promise<void>;
  finish(outcome: TerminalOutcome): Promise<void>;
  receive(): Promise<Delivery>;
  spawnTurn(input: TurnProgramInput): TurnHandle;
}

interface Stream {
  write(event: StreamEvent): Promise<void>;
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

### Named loop semantics

A turn is a loop with three named phases, driven by `runTurn`
([`turn-program.ts`](../packages/eve/src/internal/testing/loop-prototype/core/turn-program.ts)):

1. **Initiate.** Fold the delivery into state: append the user message, or
   resolve the pending approval it answers.
2. **Advance.** Call `next(dependencies, input)` once per **step**. A step is
   one generation plus the resolution of its immediate requests. The step
   result reuses the JavaScript iterator protocol's shape: `done: false`
   continues the loop, `done: true` carries the completion.
3. **Settle.** Commit the phase transition through `checkpoint` and map the
   completed step onto `TurnOutcome`.

`next` ([`turn-step.ts`](../packages/eve/src/internal/testing/loop-prototype/core/turn-step.ts))
owns the intra-turn mechanisms and sees only `TurnDependencies`: `generate`,
`executeTool`, `spawnChild`, and the `Stream`. The loop-mechanics operations —
`checkpoint`, `receive`, `finish`, `spawnTurn` — are statically invisible to a
step, so the mechanics/work split is enforced by the type system rather than
by convention. In production, `dependencies.generate` is the seam where typed
AI SDK generation (`streamText`, `streamObject`) lands; the prototype scripts
it as one `generate` method because the conformance suite does not stream.

The step body is written in the shape of a minimal harness loop
([pi](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/): generate,
stop when the model returns no requests, otherwise execute the requests and
feed results back). One step reads top to bottom: generate; a finish completes
the turn; an approval parks it; otherwise every subagent spawns before the
first tool executes, tools run one at a time in request order, and child
results fold back in request order — spawning is explicit in the step body,
never buried in request resolution, and a subagent listed after a tool does
not wait for that tool to start running.

The names come from the harnesses that already run this loop:

| eve                         | AI SDK                                                                                                        | OpenAI Agents SDK                                                                                                     | LangGraph / Inngest                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| turn                        | one agent invocation                                                                                          | one `Runner.run`, "a single logical turn in a chat conversation"                                                      | one graph `invoke`                                                                |
| step                        | [step](https://ai-sdk.dev/docs/agents/loop-control): the unit `stepCountIs` counts and `prepareStep` prepares | one loop iteration, bounded by `max_turns`                                                                            | LangGraph [super-step](https://docs.langchain.com/oss/python/langgraph/graph-api) |
| `next(dependencies, input)` | — (module imports)                                                                                            | — (module imports)                                                                                                    | `node(state, config, runtime)`; Inngest handler `({ event, step })`               |
| step decision               | [`stopWhen`](https://ai-sdk.dev/docs/agents/loop-control): continue after tool results until a stop condition | ["If the LLM returns a `final_output`, the loop ends"](https://openai.github.io/openai-agents-python/running_agents/) | node votes to halt                                                                |

The per-step decision follows the same taxonomy those documents describe:
continue after resolved tool results, park on a request that needs approval,
stop on a final output — eve's `done: false`, `waiting-approval`, and
`reply`/`terminal` by session mode.

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
`executeTool(request): Promise<RequestResult>`, both on `TurnDependencies` so
they are reachable from a step. Their definitions in
[`effect-definitions.ts`](../packages/eve/src/internal/testing/loop-prototype/core/effect-definitions.ts)
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
- Child IDs are observable before results, every child spawns before the
  first tool of its step executes, and results retain request order.
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
