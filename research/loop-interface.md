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

This research proposes a `Loop` interface analogous to `workflow`'s `World`, with the same
ownership direction: the core owns all control flow, the implementation provides primitives. The
agent loop becomes two plain programs — `runSession` and `runTurn` — that contain the entire
orchestration, including failure handling and result propagation. The durable-execution
implementation provides hooks (`Loop`: receive input, generate a stream, execute a tool, spawn a
child run, emit) plus one generic trampoline that executes whatever program it is handed. The
implementation never contains orchestration; the programs never touch durable-execution
primitives. The loop should be understandable at a glance; the substrate should be swappable
(Workflow DevKit today, in-memory for tests and fast local dev).

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

### Ownership: programs call hooks, never the reverse

A loop body is a **program**: plain, deterministic, substrate-agnostic async code that owns its
control flow end to end. The implementation is passive — it supplies the hooks a program calls
and a trampoline that starts the program it was handed. Control is never deferred downward: the
implementation cannot run a turn, publish a result, or fail a session, because none of that logic
lives there.

```ts
/** A loop program: plain orchestration code, owned by eve core. */
export type LoopProgram<I, O> = (loop: Loop, input: I) => Promise<O>;
```

### The `Loop` hook interface

```ts
/**
 * The hooks a durable-execution implementation provides. Members marked
 * "parks" suspend the run durably. Nothing here dispatches, publishes, or
 * finalizes — those verbs belong to the programs.
 */
export interface Loop {
  /**
   * Runs a program as a detached durable child run (latest deployment) and
   * returns its result. The child's `return` value IS the publication —
   * there is no publish hook. Parks.
   */
  spawn<I, O>(program: LoopProgram<I, O>, input: I): Promise<O>;

  /**
   * Resolves external input through the channel adapter. With no pending
   * delivery, waits for the next one addressed to this run (token derived
   * from the `session` the program passes in). Parks.
   */
  receiveInput(input: {
    delivery?: DeliverPayload;
    session: SessionState;
  }): Promise<StepInput | undefined>;

  /** One model call: never executes tools, never parks. */
  generateStream(input: ModelCallInput): Promise<ModelTurn>; // { messages, requests }

  executeTool(input: ToolExecInput): Promise<ToolExecResult>;

  /** Emits a HITL request batch and awaits the responses. Parks. */
  requestInput(input: InputRequestBatch): Promise<InputResponse>;

  createSession(input: SessionCreateInput): Promise<SessionState>;

  /** Emits one control-plane event to the session event stream. */
  emit(event: HandleMessageStreamEvent): Promise<void>;
}
```

`spawn` is the load-bearing hook. It expresses both durable boundaries eve has:

- **turn**: `loop.spawn(runTurn, { delivery, session })` — the pinned session run gets turn code
  from the latest deployment;
- **subagent**: `loop.spawn(runSession, toSubagentInput(session, request))` — a subagent is not a
  special mechanism, it is the session program run as a child.

Because `spawn` returns the child's result, the entire result-publication machinery
(`NextDriverAction` today, `publishResult` in an earlier draft of this document) disappears from
the API. The wire envelope `spawn` uses — serialized `(program, input)` in, serialized
result/error out, `SessionState` inside both — is the closed cross-deployment contract, with the
usual evolution rule (new optional fields OK, no destructure-and-rebuild).

```ts
/**
 * The serializable cross-run state, threaded explicitly through `spawn`:
 * in via the program's input, out via its result. Subsumes today's
 * `DurableSessionState` + serialized runtime context.
 */
export type SessionState = {
  /* sessionId, continuationToken, history, state, context, … */
};
```

### The programs

This is the entire orchestration surface. Note that terminal failure handling is inside the
program — the trampoline only rethrows:

```ts
export async function runSession(loop: Loop, input: SessionRunInput): Promise<unknown> {
  try {
    let session = await loop.createSession(input);
    let delivery: DeliverPayload | undefined = input.initialDelivery;

    while (true) {
      const result = await loop.spawn(runTurn, { delivery, session });
      session = result.session;

      if (result.kind === "done") return result.output;

      delivery = await loop.receiveInput({ session }); // ← the park
    }
  } catch (error) {
    await loop.emit(createSessionFailedEvent(error)); // terminal failure is loop-owned
    throw error;
  }
}

export async function runTurn(loop: Loop, input: TurnRunInput): Promise<TurnRunResult> {
  let { session } = input;
  let stepInput = await loop.receiveInput({ delivery: input.delivery, session });

  while (true) {
    const { messages, requests } = await loop.generateStream({ session, stepInput });
    session = appendHistory(session, messages);
    if (requests.length === 0) return { kind: "done", output: finalOutput(messages), session };

    const approved = await resolveApprovals(loop, session, requests); // loop.requestInput
    const results = await Promise.all(
      approved.map((request) => executeRequest(loop, session, request)),
    );
    session = appendHistory(session, toToolResults(results));
    stepInput = undefined;
  }
}

export type TurnRunResult =
  | { kind: "done"; output: unknown; isError?: boolean; session: SessionState }
  | { kind: "park"; session: SessionState };
```

`executeRequest` pattern-matches the closed request union and awaits each arm explicitly:

```ts
switch (request.kind) {
  case "tool-call":
    return loop.executeTool({ request, session });
  case "subagent-call":
    return loop.spawn(runSession, toSubagentInput(session, request)); // a subagent IS a session
  case "authorization":
    return awaitAuthorization(loop, session, request);
  case "workflow-action":
    return awaitWorkflowAction(loop, session, request);
}
```

The key un-inversion: `generateStream` is a pure hook — `(history, tools, options) → { messages,
requests }` — that never executes tools and never parks. Tool execution, HITL, subagent waits,
and authorization waits are explicit `await`s in the program, not flags decoded three layers up.
The model-call recovery pipeline, compaction, and emission stay inside the `generateStream`
implementation, shrinking `tool-loop.ts` to the hook it actually is.

### Implementations

- **Workflow** (`#execution/`): one generic trampoline workflow executes any registered program;
  `spawn` starts the trampoline on the latest deployment and awaits the child's result over a
  private hook; parking hooks wrap `createHook` with the existing ownership-claim and rekey-race
  semantics; every other hook binds to a `"use step"` function. All of today's choreography
  (`SessionDeliveryHook`, `TurnControlReceiver`, `TurnExecutionCursor`, `NextDriverAction`
  publication) is private to this implementation. The addendum shows the satisfaction in code.
- **Memory** (`#internal/testing/` first, potentially `eve dev` later): `spawn` calls the program
  directly, `receiveInput` awaits an in-process queue, every other hook executes inline. The
  whole loop — including HITL, subagent, and parallel-child ordering — becomes unit-testable in
  milliseconds with no bundler, no subprocess, no hooks.

## Externally observable semantics (unchanged)

- The channel/client surface (`Runtime.run` / `deliver` / `getEventStream`), the protocol event
  stream, continuation-token semantics, HITL request/response shapes, task-vs-conversation park
  rules, and subagent delegation semantics do not change.
- The two-run shape survives: the session run is pinned to its starting deployment; children
  start on the latest deployment. The `spawn` envelope (+ `SessionState`) replaces
  `NextDriverAction` as the closed cross-deployment contract.
- Delivery ordering guarantees survive: public input arriving while a turn awaits a subagent is
  still relayed through a request/accept/cancel handshake (private to the workflow
  implementation), and unconsumed deliveries re-buffer ahead of later arrivals.

## Invariants

1. **Frozen session program and trampoline.** `runSession` and the trampoline replay on old
   deployments for the session's entire life. Both must stay tiny; the program treats the
   threaded `SessionState` as opaque (pass by reference, never destructure-and-rebuild).
2. **Closed `spawn` envelope.** Serialized program reference + input in, serialized result/error
   out. New optional fields OK; new shapes need a version bump and migrator, exactly like
   `DurableSessionState` today.
3. **Turn side keeps speaking to legacy drivers.** In-flight sessions started before this change
   have pinned drivers that dispatch `turnWorkflow` and read `NextDriverAction` /
   `TurnControlPayload`. The workflow implementation keeps a compatibility arm (as
   `runLegacyTurnWorkflow` does today) until those sessions drain.
4. **Hook token semantics survive inside the parking hooks.** Rekey must preserve the existing
   race behavior: a delivery committed to the old token before disposal still resolves; a later
   delivery loses to `hook_disposed` and triggers resume-or-start at the runtime layer.
5. **Single stream owner.** The session run owns the public event stream; children write through
   the parent writable. `loop.emit` (and the stream emission inside `generateStream`) is the only
   write path.
6. **State explicit at run boundaries, private within runs.** The cross-run `SessionState` is
   threaded visibly through `spawn`; within a run, program-local variables are durable via
   deterministic replay and the runtime-context cursor stays inside the hook implementation.

## What gets deleted or absorbed

| Today                                                                                                         | After                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `NextDriverAction`, `TurnControlPayload`, `TurnInboxPayload` protocols                                        | the `spawn` envelope + implementation-private mailboxes                  |
| Turn dispatch and subagent dispatch as separate mechanisms                                                    | one `spawn` hook; a subagent is `spawn(runSession, …)`                   |
| `TurnControlReceiver`, `TurnExecutionCursor`, `SessionDeliveryHook`, hook-ownership choreography in loop code | private to the workflow implementation                                   |
| Parking flags in `session.state` decoded by `derivePendingState`                                              | explicit request union returned by `generateStream`                      |
| Tool execution inside AI SDK `ToolLoopAgent`                                                                  | `executeTool` hook; SDK used for the model call only                     |
| `serializedContext` + `sessionState` ferried through every step result                                        | one `SessionState` threaded through `spawn`; private cursor within a run |

## Phasing

1. **Extract the seam.** Define `Loop`/`LoopProgram`/`SessionState`/`TurnRunResult`, the program
   registry, and the trampoline; implement the workflow hooks over the existing steps and hooks;
   rewrite `workflowEntry`'s driver loop as `runSession` with behavior pinned by existing
   integration and scenario tests.
2. **Un-invert the turn.** Split `tool-loop.ts` into the pure `generateStream` hook plus
   program-level request execution; rewrite `turnWorkflow` as `runTurn`; collapse subagent
   dispatch into `spawn`; keep the legacy-driver arm.
3. **Memory implementation.** Land the in-process hooks and move HITL/subagent/authorization
   ordering coverage from scenario tests down to program-level unit tests.

## Open questions

- Program identity across deployments: `spawn` serializes a program reference, so programs need a
  stable registry (name → program). What is the versioning story when a program's input/result
  shape changes while old sessions still spawn it?
- Does subagent-as-`spawn(runSession)` preserve today's child observability — independent child
  event streams, `$eve` lineage attributes, detached children surviving the parent turn? The
  hooks own streams and attributes, so likely yes, but the detached (fire-and-forget with late
  result) case needs a design: `spawn` as sketched is strictly awaited.
- How is program determinism enforced mechanically? A guard-invariant rule (no side-effecting
  imports in program modules) would make the rule checkable.
- Does the memory implementation become the `eve dev` fast path (skipping the local workflow
  store for ephemeral sessions), or stay test-only?
- Where does compaction live — inside the `generateStream` hook (today's placement) or as an
  explicit hook call so it is visible in the turn program?
- Can lifting tool execution out of `ToolLoopAgent` preserve provider-executed tools (web search,
  code execution) that resolve inside the model stream? Likely yes — they arrive as inline results
  on `messages`, not as `requests` — but this needs a spike.

## Addendum: how the workflow implementation satisfies the API

Concrete mapping onto Workflow DevKit, grounded in today's mechanics. Everything here is
`#execution/`-private; the programs and the `Loop`/`LoopProgram` types live in a bundler-safe
module (no node built-ins, no logging) since they execute inside `"use workflow"` bodies.

### The trampoline: the only workflow entrypoint

One generic workflow executes any registered program. It contains no session or turn knowledge —
it resolves the program by name, builds the hooks, runs the program, and reports the return value
(or error) to whoever spawned it:

```ts
export async function loopRun(envelope: SpawnEnvelope): Promise<unknown> {
  "use workflow";

  const program = resolveProgram(envelope.program); // eve-owned registry: name → LoopProgram
  const loop = createWorkflowHooks({
    runId: getWorkflowMetadata().workflowRunId,
    writable: getWritable<Uint8Array>(),
  });

  try {
    const result = await program(loop, envelope.input);
    if (envelope.replyTo) await resumeParentStep(envelope.replyTo, { ok: true, result });
    return result;
  } catch (error) {
    if (envelope.replyTo) {
      await resumeParentStep(envelope.replyTo, {
        error: normalizeSerializableError(error),
        ok: false,
      });
    }
    throw error;
  }
}
```

`SpawnEnvelope` — `{ program: string; input: unknown; replyTo?: string }` plus the result payload
— is the closed cross-deployment contract (invariant 2). A root session is the same trampoline
started by `Runtime.run` with no `replyTo`.

The registry is resolved on the **child's** deployment: the pinned session run spawns by name,
and the latest deployment supplies the program body. That is how turn code rotates while the
session program stays frozen.

### `spawn`: start on latest, await the result hook

```ts
async function spawn<I, O>(program: LoopProgram<I, O>, input: I): Promise<O> {
  const replyTo = `${runId}:spawn:${String(spawnSeq++)}`; // replay-deterministic

  // One "use step": start(loopRunReference, [{ program: nameOf(program),
  // input, replyTo }], { deploymentId: "latest" }).
  await spawnStep({ input, program: nameOf(program), replyTo });

  // Wait on the replyTo hook until the child's terminal payload, servicing
  // intermediate payloads privately — today's TurnControlReceiver, generalized:
  //   continuation-token updates → rekey the session inbox
  //   delivery-request           → race inbox vs replyTo; forward through the
  //                                request/accept/cancel handshake
  //   { ok } / { error }         → return the result or rethrow
  return awaitSpawnResult<O>(replyTo);
}
```

The mid-run relay is the one place parent and child hooks cooperate: while a parent is parked in
`spawn`, public input addressed to the session is relayed to the child (which may be waiting in
`receiveInput` or `requestInput`) through the request/accept/cancel handshake. All of it is
private to the hook implementation; neither program ever sees a control payload.

### The parking hooks

Every parking hook wraps a private mailbox over `createHook`, carrying today's semantics
verbatim: construction claims ownership (`claimHookOwnership`); a wait advances the hook
iterator; the resume side is unchanged — `Runtime.deliver`, auth callbacks, and spawned children
all still call `resumeHook(token, payload)`. Session-level `receiveInput` rekeys to the
continuation token carried by the `session` the program passes in (claim candidate, drain reads
committed to the old token, dispose, keep the retired hook in the delivery race — the
`SessionDeliveryHook` algorithm moves here unchanged, invariant 4).

### Binding effect hooks to steps

`"use step"` is a compile-time directive with devalue-serializable inputs and outputs, so a hook
cannot close over live objects (the deserialized context, the adapter, resolved tools). Each
effect hook calls a top-level step function, threading the runtime-context cursor — the one
mutable slice inside a run (adapter state, dynamic resolvers) — in and adopting it back out.
`TurnExecutionCursor`'s job, kept, but private to `createWorkflowHooks`. Replay-safe: memoized
step results replay the same cursor transitions in the same order:

```ts
function createWorkflowHooks(env: HookEnv): Loop {
  let context = env.initialContext; // runtime-context cursor, private
  let spawnSeq = 0;
  const adopt = <O>(r: StepOutcome<O>): O => {
    context = r.context ?? context;
    return r.output;
  };

  return {
    spawn: /* above */,
    receiveInput: async (input) => adopt(await receiveInputStep({ ...input, context })),
    generateStream: async (input) =>
      adopt(await generateStreamStep({ ...input, context, writable: env.writable })),
    executeTool: async (input) => adopt(await executeToolStep({ ...input, context })),
    requestInput: async (batch) => {
      adopt(await emitInputRequestedStep({ batch, context }));
      return awaitInboxResponse(batch); // park on this run's inbox
    },
    createSession: async (input) => adopt(await createSessionStep({ ...input, context })),
    emit: (event) => emitEventStep({ event, writable: env.writable }),
  };
}

async function generateStreamStep(
  input: ModelCallInput & { readonly context: SerializedContext /* … */ },
): Promise<StepOutcome<ModelTurn>> {
  "use step";
  const ctx = await deserializeContext(input.context);
  // hydrate bundle + adapter, resolve model/tools, stream events to the writable…
  return { output: { messages, requests }, context: serializeContext(ctx) };
}
```

The cursor's final value merges into the `SessionState` the program returns — reassembling the
explicit contract at the run boundary happens inside `spawn`'s result path, not in program code.

Step payloads shrink relative to today: `generateStreamStep` returns the turn's new messages and
requests, not a full `DurableSessionState` snapshot per step. The full snapshot is written once,
into the spawn result — the run boundary the cross-deployment contract actually needs
(invariant 6).

### What the substrate imposes

- **Deterministic programs.** Programs replay inside `"use workflow"`: no `Date.now()`, no
  randomness, no I/O outside `loop`, and hook tokens and spawn counters derived from replayed
  state only. This is the rule the proposed guard-invariant would check.
- **Bundler-safe modules.** Anything imported into a program module must survive the workflow
  bundler — same constraint `workflow-entry.ts` documents today.
- **Emission split.** `loop.emit` is a step that writes the parent writable and is reserved for
  control-plane events (`session.failed`, `subagent.called`); high-frequency stream emission
  happens inside `generateStreamStep`, which holds the writer for the duration of the call.
- **Stable ids and the legacy arm.** The trampoline keeps a version-stamp-free workflow id
  (`STABLE_WORKFLOW_NAMES`) so pinned sessions route across deployments, and the implementation
  keeps `runLegacyTurnWorkflow` + the old `workflowEntry`/`turnWorkflow` ids until pre-change
  sessions drain.
