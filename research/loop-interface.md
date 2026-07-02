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
same for eve: the agent loop is written once as straight-line, readable async code against a
single injected `LoopEffects` bundle — receive input, generate a stream, execute tools, dispatch
subagents — minted per run by the `Loop` substrate (`loop.create()`). Durability and parking are
properties of the wiring, not the loop's vocabulary: the workflow composition binds each member to
a `"use step"` function or a hook wait, the memory composition executes directly. The loop should
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

`Loop` is the substrate — one instance per composition, analogous to `World`. Its only job is to
mint the per-run effect bundle. Everything a loop body can do, including the waits that park the
run, is a member of that bundle; nothing about hooks, step boundaries, or memoization appears in
the vocabulary.

```ts
/** Durable-execution substrate. `create()` mints the effect bundle for one run. */
export interface Loop {
  create(input: LoopCreateInput): LoopEffects;
}

/** Everything a loop body may do. Members marked "parks" suspend the run durably. */
export type LoopEffects = {
  // session level
  createSession(input: SessionCreateInput): Promise<SessionSnapshot>;
  /** Starts the per-turn child run on the latest deployment and awaits its result. Parks. */
  runTurn(input: TurnRunInput): Promise<TurnRunResult>;
  /**
   * Waits for the next external input addressed to this run and resolves it
   * through the channel adapter. Parks.
   */
  receiveInput(input: ReceiveInputInput): Promise<StepInput | undefined>;

  // turn level
  generateStream(input: ModelCallInput): Promise<ModelTurn>; // { messages, requests }
  executeTool(input: ToolExecInput): Promise<ToolExecResult>;
  /** Starts a delegated child run and awaits its result. Parks. */
  dispatchSubagent(input: SubagentDispatchInput): Promise<SubagentResult>;
  /** Emits a HITL request batch and awaits the responses. Parks. */
  requestInput(input: InputRequestBatch): Promise<InputResponse>;

  /** Emits one control-plane event to the session event stream. */
  emit(event: HandleMessageStreamEvent): Promise<void>;

  // composition-root only — loop bodies never call these
  failSession(error: SerializableError): Promise<void>;
  dispose(): Promise<void>;
};
```

Parking is a property of individual members, not a separate primitive: there is no public mailbox
or token surface. Hook claims, continuation-token rekeying, and delivery races are private to the
composition's `create()` closure, which also owns all per-run mutable state (the runtime-context
cursor, dispatch counters).

Durability is likewise a wiring concern, invisible to the loop bodies: the workflow composition
binds every member to a `"use step"` function (satisfying the Workflow DevKit compile-time
directive constraint) or a hook wait, so each effect is memoized and replay-safe by construction.
The memory composition binds the same members to direct implementations. The one rule the bodies
must follow is determinism: every side effect goes through `effects`, nothing else.

### The loop bodies

Two plain async functions, both deterministic and replayable, both readable top to bottom. This is
the entire orchestration surface (elided error handling and finalization):

```ts
export async function runSessionLoop(
  effects: LoopEffects,
  input: SessionRunInput,
): Promise<unknown> {
  let session = await effects.createSession(input);
  let delivery: DeliverPayload | undefined = input.initialDelivery;

  while (true) {
    const result = await effects.runTurn({ delivery, session });
    session = result.session;

    if (result.kind === "done") return result.output;

    delivery = await effects.receiveInput({ session }); // ← the park; rekey happens inside
  }
}

export async function runTurnLoop(
  effects: LoopEffects,
  input: TurnRunInput,
): Promise<TurnRunResult> {
  let { session } = input;
  let stepInput = await effects.receiveInput({ delivery: input.delivery, session });

  while (true) {
    const { messages, requests } = await effects.generateStream({ session, stepInput });
    session = appendHistory(session, messages);
    if (requests.length === 0) return { kind: "done", output: finalOutput(messages), session };

    const approved = await resolveApprovals(effects, session, requests); // effects.requestInput
    const results = await Promise.all(
      approved.map((request) => executeRequest(effects, session, request)),
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
    return effects.dispatchSubagent({ request, session }); // parks until the child resolves
  case "authorization":
    return awaitAuthorization(effects, session, request);
  case "workflow-action":
    return awaitWorkflowAction(effects, session, request);
}
```

The key un-inversion: `generateStream` becomes a pure effect — `(history, tools, options) → {
messages, requests }` — that never executes tools and never parks. Tool execution, HITL, subagent
waits, and authorization waits are explicit `await`s in the loop, not flags decoded three layers
up. The model-call recovery pipeline, compaction, and emission stay inside the `generateStream`
effect where they belong, shrinking `tool-loop.ts` to the effect it actually is.

### Compositions

- **Workflow** (`#execution/`): `create()` closes over the per-run hooks and context cursor.
  Parking members wrap `createHook` with the existing ownership-claim and rekey-race semantics;
  `runTurn` wraps `start(turnWorkflowReference, …, { deploymentId: "latest" })` plus the
  turn-control wait; `emit` writes the session's `getWritable()` stream; every other member is
  bound to a `"use step"` function. All of today's hook choreography (`SessionDeliveryHook`,
  `TurnControlReceiver`, `TurnExecutionCursor`, hook-ownership claims) becomes private
  implementation detail of this composition.
- **Memory** (`#internal/testing/` first, potentially `eve dev` later): effects execute directly,
  `receiveInput` awaits an in-process queue, `runTurn` calls `runTurnLoop` inline.
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
3. **Hook token semantics survive inside `receiveInput`.** Rekey must preserve the existing race
   behavior: a delivery committed to the old token before disposal still resolves; a later
   delivery loses to `hook_disposed` and triggers resume-or-start at the runtime layer.
4. **Single stream owner.** The session run owns the public event stream; turns write through the
   parent writable. `effects.emit` (and the stream emission inside `generateStream`) is the only
   write path.
5. **State at run boundaries, not step boundaries.** Loop-local variables (`session`, `history`)
   are durable via deterministic replay; `DurableSessionState` snapshots persist only where a run
   boundary or cross-deployment contract requires them.

## What gets deleted or absorbed

| Today                                                                                                         | After                                                        |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `NextDriverAction`, `TurnControlPayload`, `TurnInboxPayload` protocols                                        | one `TurnRunResult` contract + composition-private mailboxes |
| `TurnControlReceiver`, `TurnExecutionCursor`, `SessionDeliveryHook`, hook-ownership choreography in loop code | private to the workflow composition                          |
| Parking flags in `session.state` decoded by `derivePendingState`                                              | explicit request union returned by `generateStream`          |
| Tool execution inside AI SDK `ToolLoopAgent`                                                                  | `executeTool` effect; SDK used for the model call only       |
| `serializedContext` + `sessionState` ferried through every step result                                        | loop-local variables; snapshots at run boundaries            |

## Phasing

1. **Extract the seam.** Define `Loop`/`LoopEffects`/`TurnRunResult`; build the workflow
   composition over the existing steps and hooks; rewrite `workflowEntry`'s driver loop as
   `runSessionLoop` with behavior pinned by existing integration and scenario tests.
2. **Un-invert the turn.** Split `tool-loop.ts` into the pure `generateStream` effect plus
   loop-level request execution; rewrite `turnWorkflow` as `runTurnLoop`; keep the
   legacy-driver arm.
3. **Memory composition.** Land the in-process implementation and move
   HITL/subagent/authorization ordering coverage from scenario tests down to loop-level unit
   tests.

## Open questions

- Should `LoopEffects` stay one flat bundle, or split into session/turn views so each body can
  only reach its own members? One bundle is simpler; two views make misuse unrepresentable.
- Does session-level `receiveInput` fully subsume rekeying — i.e. can the composition always
  derive the current token from its context cursor — or do channel-driven token changes
  (`setContinuationToken`) need an explicit signal on the bundle?
- How is effect durability enforced mechanically? `Loop.create()` is the only constructor of the
  bundle, but a guard-invariant rule (no side-effecting imports in loop-body modules) would make
  the determinism rule checkable.
- Does the memory composition become the `eve dev` fast path (skipping the local workflow store
  for ephemeral sessions), or stay test-only?
- Where does compaction live — inside the `generateStream` effect (today's placement) or as an
  explicit effect call so it is visible in the turn body?
- Can lifting tool execution out of `ToolLoopAgent` preserve provider-executed tools (web search,
  code execution) that resolve inside the model stream? Likely yes — they arrive as inline results
  on `messages`, not as `requests` — but this needs a spike.

## Addendum: sketch of the workflow composition

How the API maps onto Workflow DevKit. Everything here is `#execution/`-private; the loop bodies
and the `Loop`/effects interfaces live in a bundler-safe module (no node built-ins, no logging)
since they execute inside `"use workflow"` bodies.

### Entrypoints

The two workflow functions become thin composition roots: mint the effect bundle via
`loop.create()`, run the body, publish the outcome. Nothing else lives at this layer.

```ts
const loop = createWorkflowLoop(); // module-level substrate, like setWorld()

export async function sessionWorkflow(input: SessionWorkflowInput): Promise<WorkflowEntryResult> {
  "use workflow";

  const { workflowRunId: sessionId } = getWorkflowMetadata();
  const effects = loop.create({
    kind: "session",
    serializedContext: input.serializedContext,
    sessionId,
    writable: getWritable<Uint8Array>(),
  });

  try {
    return { output: await runSessionLoop(effects, toSessionRunInput(sessionId, input)) };
  } catch (error) {
    await effects.failSession(normalizeSerializableError(error)); // terminal session.failed + callbacks
    throw error;
  } finally {
    await effects.dispose();
  }
}

export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";

  const input = migrateTurnWorkflowInput(rawInput);
  if (isLegacyDriverDispatch(input)) return runLegacyTurnWorkflow(input); // invariant 2

  const effects = loop.create({
    controlToken: input.completionToken,
    kind: "turn",
    parentWritable: input.stepInput.parentWritable,
    serializedContext: input.stepInput.serializedContext,
  });

  try {
    const result = await runTurnLoop(effects, toTurnRunInput(input));
    await publishTurnResultStep({ controlToken: input.completionToken, result });
  } catch (error) {
    await publishTurnErrorStep({
      controlToken: input.completionToken,
      error: normalizeSerializableError(error),
    });
    throw error;
  } finally {
    await effects.dispose();
  }
}
```

`failSession` and `dispose` are composition-root members (terminal failure emission; hook and
iterator cleanup) — the loop bodies never call them.

### Binding effects to steps

`"use step"` is a compile-time directive with devalue-serializable inputs and outputs, so an
effect member cannot close over live objects (the deserialized context, the adapter, resolved
tools). Each member binds to a top-level step function, and the one piece of mutable runtime
state — the serialized context that adapters and dynamic resolvers mutate — becomes a private
cursor inside the bundle `create()` returns. This is `TurnExecutionCursor`'s job, kept, but
hidden from the loop body:

```ts
function createTurnBundle(env: TurnCreateInput): LoopEffects {
  // Replay-safe: memoized step results replay the same cursor transitions
  // in the same order, so `context` converges identically on every replay.
  let context = env.serializedContext;
  const adopt = <O>(result: { output: O; context?: SerializedContext }): O => {
    context = result.context ?? context;
    return result.output;
  };

  return {
    receiveInput: async (input) => adopt(await receiveInputStep({ ...input, context })),
    generateStream: async (input) => adopt(await generateStreamStep({ ...input, context })),
    executeTool: async (input) => adopt(await executeToolStep({ ...input, context })),
    dispatchSubagent: async (input) => awaitSubagentResult(input, context), // dispatch step + hook wait
    // ...
  };
}

async function generateStreamStep(
  input: ModelCallInput & { readonly context: SerializedContext },
): Promise<{ output: ModelTurn; context: SerializedContext }> {
  "use step";
  const ctx = await deserializeContext(input.context);
  // hydrate bundle + adapter, resolve model/tools, stream events to the writable…
  return { output: { messages, requests }, context: serializeContext(ctx) };
}
```

Step payloads shrink relative to today: `generateStreamStep` returns the turn's new messages and
requests, not a full `DurableSessionState` snapshot per step. The full snapshot is written once,
at the turn result — the run boundary the cross-deployment contract actually needs (invariant 5).

### Parking members over hooks

Every member marked "parks" wraps a private mailbox over `createHook`, carrying today's semantics
verbatim:

- construction claims ownership (`claimHookOwnership`); a conflict means another replica owns the
  token and the run bows out, exactly like the turn-inbox claim today;
- a wait advances the hook iterator; the resume side is unchanged — `Runtime.deliver`, auth
  callbacks, and subagent completions all still call `resumeHook(token, payload)`;
- session-level `receiveInput` rekeys to the current continuation token (read from the context
  cursor) before waiting: claim the candidate token, drain reads already committed to the old
  token, dispose it, and keep the retired hook in the delivery race — the `SessionDeliveryHook`
  algorithm moves here unchanged (invariant 3).

### `runTurn` internals (session side)

`TurnControlReceiver`'s protocol survives as the private body of one member:

1. `dispatchTurnStep` — `start(turnWorkflowReference, [input], { deploymentId: "latest" })`.
2. Open a control mailbox at `${sessionId}:turn-control:${n}`; `n` is a bundle-instance counter,
   deterministic under replay.
3. Service control payloads privately: `turn-continuation-token` rekeys the session inbox;
   `turn-delivery-request` races the session inbox against control and forwards through the
   request/accept/cancel handshake; `turn-result` / `turn-error` terminate.
4. Dispose the control mailbox; return the `TurnRunResult`.

On the turn side the same handshake is the private body of the turn bundle's parking members: a
mid-turn wait while descendants are active sends `turn-delivery-request` and resolves on
accept/cancel. Neither loop body ever sees a control payload kind.

### What the substrate imposes

- **Deterministic bodies.** Loop bodies replay inside `"use workflow"`: no `Date.now()`, no
  randomness, no I/O outside `effects`, and hook tokens and dispatch counters derived from
  replayed state only. This is the rule the proposed guard-invariant would check.
- **Bundler-safe modules.** Anything imported into a workflow body must survive the workflow
  bundler — same constraint `workflow-entry.ts` documents today.
- **Emission split.** `effects.emit` is a step that writes the parent writable and is reserved
  for loop-level control-plane events (`session.failed`, `subagent.called`); high-frequency
  stream emission happens inside `generateStreamStep`, which holds the writer for the duration of
  the call.
- **Stable ids and the legacy arm.** `sessionWorkflow`/`turnWorkflow` keep version-stamp-free
  workflow ids (`STABLE_WORKFLOW_NAMES`) so pinned drivers route across deployments, and the turn
  entrypoint keeps `runLegacyTurnWorkflow` until pre-change sessions drain.
