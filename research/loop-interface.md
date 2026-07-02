---
issue: https://github.com/vercel/eve/issues/512
last_updated: "2026-07-02"
status: proposed
---

# `Loop`: decouple the agent loop from durable-execution orchestration

## Summary

The agent loop — deliver input, call the model, execute tools, wait for humans, repeat — is not
written anywhere as a loop. It is smeared across four layers (`workflowEntry` driver,
`turnWorkflow` child, `turnStep`, `createToolLoopHarness`), each directly coupled to Workflow
DevKit primitives (`"use workflow"`, `"use step"`, `createHook`, `getWritable`, `start`). Control
flow is inverted: the harness _returns_ instead of awaiting, encoding "why I stopped" into flags
buried in `session.state` (`pendingRuntimeActionKeys`, `hasPendingInputBatch`,
`hasPendingAuthorization`, `pendingWorkflowInterrupt`); higher layers decode those flags to pick
the next dispatch. Every stop reason grew its own hook protocol — session delivery hook (with
rekey races), auth hook, turn inbox, turn control token, driver-delivery handshake — and all state
is ferried as `serializedContext` + `DurableSessionState` blobs through every boundary.

This research proposes a `Loop` interface analogous to `workflow`'s `World`. `World` lets workflow
core express workflow semantics once while queue/storage/streams stay pluggable. `Loop` does the
same for eve: the agent loop is written once as straight-line, readable async code over two seams
— `Loop` for the substrate primitives (parking, child runs, the event stream) and injected effect
interfaces for everything side-effecting (model call, tool execution, adapter callbacks).
Durability is a property of the wiring, not the loop's vocabulary: the workflow composition binds
each effect to a `"use step"` function, the memory composition executes directly. The loop should
be understandable at a glance; the orchestration substrate should be swappable (Workflow DevKit
today, in-memory for tests and fast local dev).

## Current shape

```
Runtime.run()
  └─ workflowEntry            "use workflow"  (pinned to starting deployment)
       ├─ createSessionStep
       ├─ session delivery hook + auth hook  (createHook, rekey races)
       └─ per turn: dispatchAndAwaitTurn ── TurnControlReceiver ⇆ control hook
            └─ turnWorkflow   "use workflow"  (child run, latest deployment)
                 ├─ turn inbox hook + TurnExecutionCursor
                 └─ loop: turnStep  "use step"
                      ├─ readDurableSession / deserializeContext
                      ├─ adapter deliver → StepInput
                      ├─ createToolLoopHarness step   (model call + tool exec inside
                      │    AI SDK ToolLoopAgent; parks via `next: null` + state flags)
                      └─ serializeContext / createDurableSessionState → DurableStepResult
```

Consequences:

- No single file shows the loop. Reading "what happens on a turn" requires holding five protocols
  in your head (`NextDriverAction`, `TurnControlPayload`, `TurnInboxPayload`, `HookPayload`,
  `DurableStepResult`).
- The harness cannot be tested as a loop without the workflow bundler; unit tests poke at state
  flags instead of observable behavior.
- Tool execution happens inside the AI SDK's `ToolLoopAgent`, so HITL approval, runtime-action
  dispatch, and parallel tool execution are all bolted on around it rather than expressed by the
  loop.
- `tool-loop.ts` is 2,248 lines because it hosts the loop, the effects, the recovery pipeline, and
  the parking encodings at once.

## Proposed authoring API

### The `Loop` interface

`Loop` carries only what is inherent to any loop substrate: parking on external input, running a
turn as a child run, and the event stream. It says nothing about memoization or step boundaries —
those are how the workflow implementation makes effects durable, not something the loop needs to
name. Like `World`, it is a narrow contract with multiple implementations.

```ts
/** Durable-execution substrate for one agent loop run. */
export interface Loop {
  /**
   * Starts the per-turn child run on the latest deployment and awaits its
   * terminal result. Session-level bodies only.
   */
  runTurn(input: TurnRunInput): Promise<TurnRunResult>;

  /** Claims an addressable mailbox for external payloads. */
  mailbox<T>(token: string): Promise<LoopMailbox<T>>;

  /** Emits one protocol event to the session event stream. */
  emit(event: HandleMessageStreamEvent): Promise<void>;
}

/** Parking point for external input. `receive()` suspends the run durably. */
export interface LoopMailbox<T> {
  receive(): Promise<T>;
  /** Atomically retires the current token and claims the next one. */
  rekey(token: string): Promise<void>;
  dispose(): Promise<void>;
}
```

### Effects

Everything side-effecting the loop performs — the model call, tool execution, adapter callbacks,
subagent dispatch — is an ordinary injected dependency, not a `Loop` method:

```ts
/** Side-effecting operations available to the turn loop. */
export interface TurnEffects {
  adapterDeliver(input: AdapterDeliverInput): Promise<StepInput | undefined>;
  callModel(input: ModelCallInput): Promise<ModelTurn>; // { messages, requests }
  executeTool(input: ToolExecInput): Promise<ToolExecResult>;
  dispatchSubagent(input: SubagentDispatchInput): Promise<SubagentDispatch>;
  // ...closed, eve-owned vocabulary; grows by adding members
}
```

Durability is a wiring concern, invisible to the loop bodies: the workflow composition root binds
every member to a `"use step"` function (satisfying the Workflow DevKit compile-time directive
constraint), so each effect is memoized and replay-safe by construction. The memory composition
binds the same members to direct implementations. The one rule the bodies must follow is
determinism: every side effect goes through `effects` or `loop`, nothing else.

### The loop bodies

Two plain async functions, both deterministic and replayable, both readable top to bottom. This is
the entire orchestration surface (elided error handling and finalization):

```ts
export async function runSessionLoop(
  loop: Loop,
  effects: SessionEffects,
  input: SessionRunInput,
): Promise<unknown> {
  let session = await effects.createSession(input);
  const inbox = await loop.mailbox<DeliverPayload>(session.continuationToken);
  let delivery: DeliverPayload | undefined = input.initialDelivery;

  while (true) {
    const result = await loop.runTurn({ delivery, session });
    session = result.session;

    if (result.kind === "done") return result.output;

    await inbox.rekey(session.continuationToken);
    delivery = await inbox.receive(); // ← the park
    delivery = await routeToDescendants(effects, session, delivery);
  }
}

export async function runTurnLoop(
  loop: Loop,
  effects: TurnEffects,
  input: TurnRunInput,
): Promise<TurnRunResult> {
  let { session } = input;
  let stepInput = await effects.adapterDeliver({ delivery: input.delivery, session });

  while (true) {
    const { messages, requests } = await effects.callModel({ session, stepInput });
    session = appendHistory(session, messages);
    if (requests.length === 0) return { kind: "done", output: finalOutput(messages), session };

    const approved = await resolveApprovals(loop, effects, session, requests); // HITL park, if any
    const results = await Promise.all(
      approved.map((request) => executeRequest(loop, effects, session, request)),
    );
    session = appendHistory(session, toToolResults(results));
    stepInput = undefined;
  }
}
```

`executeRequest` pattern-matches the closed request union and awaits each arm explicitly:

```ts
switch (request.kind) {
  case "tool-call":
    return effects.executeTool({ request, session });
  case "subagent-call":
    return awaitSubagent(loop, effects, session, request); // mailbox park
  case "authorization":
    return awaitAuthorization(loop, effects, session, request);
  case "workflow-action":
    return awaitWorkflowAction(loop, effects, session, request);
}
```

The key un-inversion: `callModel` becomes a pure effect — `(history, tools, options) → { messages,
requests }` — that never executes tools and never parks. Tool execution, HITL, subagent waits, and
authorization waits are explicit `await`s in the loop, not flags decoded three layers up. The
model-call recovery pipeline, compaction, and emission stay inside the `callModel` effect where
they belong, shrinking `tool-loop.ts` to the effect it actually is.

### Compositions

- **Workflow** (`#execution/`): `mailbox` wraps `createHook` with the existing ownership-claim
  and rekey-race semantics; `runTurn` wraps `start(turnWorkflowReference, …, { deploymentId:
"latest" })` plus the turn-result mailbox; `emit` writes the session's `getWritable()` stream;
  each effect member is bound to a `"use step"` function. All of today's hook choreography
  (`SessionDeliveryHook`, `TurnControlReceiver`, `TurnExecutionCursor`, hook-ownership claims)
  becomes private implementation detail of this composition.
- **Memory** (`#internal/testing/` first, potentially `eve dev` later): effects execute directly,
  `mailbox.receive` awaits an in-process queue, `runTurn` calls `runTurnLoop` inline.
  The whole session loop — including HITL and subagent ordering — becomes unit-testable in
  milliseconds with no bundler, no subprocess, no hooks.

## Externally observable semantics (unchanged)

- The channel/client surface (`Runtime.run` / `deliver` / `getEventStream`), the protocol event
  stream, continuation-token semantics, HITL request/response shapes, task-vs-conversation park
  rules, and subagent delegation semantics do not change.
- The two-run shape survives: the session run is pinned to its starting deployment and must stay
  minimal and frozen; turn runs start on the latest deployment. `TurnRunResult` replaces
  `NextDriverAction` as the closed cross-deployment contract, with the same evolution rule (new
  optional fields OK, new arms breaking, no destructure-and-rebuild).
- Delivery ordering guarantees survive: public input arriving while a turn awaits a subagent is
  still relayed through a request/accept/cancel handshake (inside the workflow composition), and
  unconsumed
  deliveries re-buffer ahead of later arrivals.

## Invariants

1. **Frozen session body.** `runSessionLoop` replays on old deployments for the session's entire
   life. It must stay tiny, dispatch only through the closed `TurnRunResult` contract, and never
   grow logic that a pinned replica cannot execute.
2. **Turn side keeps speaking to legacy drivers.** In-flight sessions started before this change
   have pinned drivers that dispatch `turnWorkflow` and read `NextDriverAction` /
   `TurnControlPayload`. The turn entrypoint keeps a compatibility arm (as `runLegacyTurnWorkflow`
   does today) until those sessions drain.
3. **Mailbox = hook token semantics.** Rekey must preserve the existing race behavior: a delivery
   committed to the old token before disposal still resolves; a later delivery loses to
   `hook_disposed` and triggers resume-or-start at the runtime layer.
4. **Single stream owner.** The session run owns the public event stream; turns write through the
   parent writable. `loop.emit` is the only write path.
5. **State at run boundaries, not step boundaries.** Loop-local variables (`session`, `history`)
   are durable via deterministic replay; `DurableSessionState` snapshots persist only where a run
   boundary or cross-deployment contract requires them.

## What gets deleted or absorbed

| Today                                                                                                         | After                                                  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `NextDriverAction`, `TurnControlPayload`, `TurnInboxPayload` protocols                                        | one `TurnRunResult` contract + `LoopMailbox` payloads  |
| `TurnControlReceiver`, `TurnExecutionCursor`, `SessionDeliveryHook`, hook-ownership choreography in loop code | private to the workflow composition                    |
| Parking flags in `session.state` decoded by `derivePendingState`                                              | explicit request union returned by `callModel`         |
| Tool execution inside AI SDK `ToolLoopAgent`                                                                  | `executeTool` effect; SDK used for the model call only |
| `serializedContext` + `sessionState` ferried through every step result                                        | loop-local variables; snapshots at run boundaries      |

## Phasing

1. **Extract the seam.** Define `Loop`/`LoopMailbox`/`TurnRunResult` and the effect interfaces;
   build the workflow composition over the existing steps and hooks; rewrite `workflowEntry`'s
   driver loop as `runSessionLoop` with behavior pinned by existing integration and scenario
   tests.
2. **Un-invert the turn.** Split `tool-loop.ts` into the pure `callModel` effect plus loop-level
   request execution; rewrite `turnWorkflow` as `runTurnLoop`; keep the legacy-driver arm.
3. **Memory composition.** Land the in-process implementation and move
   HITL/subagent/authorization ordering coverage from scenario tests down to loop-level unit
   tests.

## Open questions

- Should `runTurn` live on `Loop` or in `SessionEffects`? On `Loop` the session/turn deployment
  split stays a substrate concern; as an effect the interface shrinks to mailbox + emit.
- How is effect durability enforced mechanically? The composition root is the only constructor of
  the effect interfaces, but a guard-invariant rule (no side-effecting imports in loop-body
  modules) would make the determinism rule checkable.
- Does the memory composition become the `eve dev` fast path (skipping the local workflow store
  for ephemeral sessions), or stay test-only?
- Where does compaction live — inside the `callModel` effect (today's placement) or as an
  explicit effect call so it is visible in the turn body?
- Can lifting tool execution out of `ToolLoopAgent` preserve provider-executed tools (web search,
  code execution) that resolve inside the model stream? Likely yes — they arrive as inline results
  on `messages`, not as `requests` — but this needs a spike.
