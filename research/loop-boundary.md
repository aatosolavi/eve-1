---
issue: TBD
last_updated: "2026-07-20"
status: proposed
---

# One pluggable Loop: simplifying eve's execution boundaries

## Summary

eve's durable execution should be one implementation of an eve-owned **Loop**
seam, replaceable by a single-process continuous loop or another durable
engine (e.g. Temporal) without touching channels, the harness, or the
runtime definition layer.

Today the "loop" is not a module. It is two Vercel Workflow programs plus a
six-hook protocol, and engine primitives leak into all three layers. This
plan is subtractive first: delete legacy protocol arms and duplicated
dispatch paths, make the harness own its result vocabulary, then extract a
small set of eve-owned contracts and quarantine every Workflow-specific
mechanism under `loop/vercel-workflow/`. An in-process Loop implementation
lands alongside to keep the seam honest and to make scenario tests run
without the workflow bundler.

## Current state

```text
channels / schedules / routes
        │  Runtime (channel/types.ts) — run/deliver/cancelTurn/resolveSession/getEventStream
        ▼
workflowEntry ("use workflow", pinned to start deployment)
   │  driver loop: create session → dispatch turn → dispatch NextDriverAction → wait
   │  hooks owned: delivery ({token}), auth ({sessionId}:auth)
   ▼
turnWorkflow ("use workflow", child run routed to deploymentId "latest")
   │  hooks owned: inbox ({completionToken}:inbox), cancel ({sessionId}:cancel)
   │  control channel back to driver: {sessionId}:turn-control:{n}
   ▼
turnStep ("use step") → harness StepFn (tool-loop) → model + tools
```

The driver/turn split, `TurnControlReceiver`, the mid-turn delivery
handshake, deferred hook disposal, `driverCapabilities` negotiation, and the
versioned wire migrations all exist to accommodate one engine property: the
driver run is pinned to its start-time deployment while turns route to the
latest deployment. A single-process loop has no deploy drift; other engines
solve it with their own versioning. None of this choreography would be
ported to another Loop — it would be deleted. That is the signal that it
belongs inside one Loop implementation, not in shared execution logic.

Three seams are already narrow and worth keeping:

- **`Runtime`** (`channel/types.ts`) — every external entry point (channel
  dispatch, schedules, subagent dispatch) funnels through
  `run/deliver/cancelTurn/resolveSession/getEventStream`.
- **Harness `StepFn`** (`harness/types.ts`) — one model step per invocation
  over a fully serializable `HarnessSession`; the harness imports zero
  execution modules.
- **`NextDriverAction`** (`execution/next-driver-action.ts`) — a closed
  union between step bodies and the driver.

## Findings

### Boundary violations

- `internal/workflow/runtime.ts` is a blanket `export *` of the vendored
  engine, not a wrapped seam. 16+ files import `resumeHook`/`getRun`/`start`
  raw, including outside execution.
- The runtime layer calls the engine directly, bypassing execution:
  `runtime/session-callback-route.ts` and
  `runtime/connections/callback-route.ts` call `resumeHook`;
  `runtime/channels/registry.ts` hard-registers execution's
  `SUBAGENT_ADAPTER` (itself built on `resumeHook`).
- Inverted runtime→execution imports (framework tools → sandbox executors,
  `runtime/prompt/compose.ts` → `execution/skills`,
  `runtime/resolve-sandbox.ts` → execution's sandbox backend) plus the
  reverse edge (`execution/sandbox/*-tool.ts` →
  `runtime/framework-tools/file-state.js`) produce two strongly connected
  components: a 29-module value cycle (workflow runtime ↔ bundle cache ↔
  sandbox backends) and a 40-module type cycle (channel ↔ harness ↔
  runtime).
- The harness has exactly three engine tendrils: `setEveAttributes` written
  from the hot loop (`tool-loop.ts`), `workflow-stream-error.ts`
  regex-parsing the engine transport's error strings, and the ordered
  emitter's chunk-alignment coalescing policy
  (`ordered-stream-emitter.ts`). Everything else in the harness is already
  engine-agnostic.

### Leaky contracts

- The park vocabulary is split three ways: the harness returns `next: null`
  for five distinct park reasons; `turnStep` re-derives which one by peeking
  at harness session-state keys (`derivePendingState`,
  `execution/workflow-steps.ts`); `DurableStepResult` and
  `NextDriverAction` then re-encode it.
- `CreateRuntime` (`execution/node-step.ts`) exists as an injection point
  but both call sites hardcode `createWorkflowRuntime`
  (`workflow-steps.ts`, `dispatch-runtime-actions-step.ts`).
- Engine value types ride shared contracts: `parentWritable:
WritableStream<Uint8Array>` (from `getWritable()`) and the durable
  `AbortSignal` thread through `TurnStepInput`, `TurnWorkflowDispatchInput`,
  `TurnExecutionCursor`, and ~15 step signatures. Only the engine's codec
  can carry them across a durable boundary.
- Session identity is minted by the engine (`sessionId === workflowRunId`),
  continuation tokens double as engine hook tokens embedded in third-party
  callback URLs, and resume-or-start (`channel/send.ts`) depends on
  `HookNotFoundError` semantics — including a raw
  `error.name === "HookNotFoundError"` string match in
  `turn-control-receiver.ts`.
- `getWorkflowMetadata()` is called inside step bodies to derive HTTP
  callback base URLs, wrapped in a swallow-everything catch
  (`workflow-steps.ts`); workflow bodies read raw `eve.*` keys out of
  `serializedContext` by cast and `workflowEntry` mutates its own input
  (`serializedContext["eve.sessionId"] = sessionId`).
- Step-cost optimizations became versioned wire schema:
  `hasProxyInputRequests` and `emissionState` live on `DurableSessionState`
  purely so the driver can skip a durable step.

### Removable code

- The legacy driver path: `runLegacyTurnWorkflow`
  (`execution/turn-workflow.ts`), the two `dispatch-*` arms of
  `NextDriverAction` that the current driver throws on
  (`workflow-entry.ts`), `driverCapabilities` negotiation, and the legacy
  `eve.session` stream-tail fallback with its timeout machinery
  (`durable-session-store.ts`). Kept only for sessions still running on
  pre-change pinned drivers. Decision: pre-1.0, breaking live pinned
  sessions on upgrade is acceptable; delete all of it.
- Two runtime-action dispatch arms (`park.pendingRuntimeActionKeys` vs
  `dispatch-workflow-runtime-actions`) that the code itself notes "differ
  only in their dispatch path" (`turn-workflow.ts`).
- Four near-identical park stores (pending input, runtime actions, sandbox
  interrupt, authorization) each re-implementing "rewind history, stash
  responseMessages, stamp emission coordinates" at four park sites in
  `tool-loop.ts`; verbatim duplicate helpers (`resolveToolCallInputObject`,
  `extractGatewayCostUsd`, `isRecord`); ~90 lines of recovery-pipeline
  machinery for exactly two stages.
- Naming debt that taxes every audit: six of the seven
  `harness/workflow-*.ts` files implement the user-facing `Workflow`
  sandbox tool, not the engine; `runtime/sessions/runtime-session.ts` is a
  process-scoped deployment cache, not a conversation session.

## Target architecture

```text
channels / schedules / routes ──▶ Runtime (unchanged)
                                     │ implemented once over Loop
                          ┌──────────▼──────────┐
                          │        Loop         │  eve-owned contract
                          │ start · signal ·    │  + error taxonomy
                          │ events · resolveWaiter
                          └────┬───────────┬────┘
              loop/vercel-workflow    loop/in-process
              (entry+turn workflows,  (plain async session
               hook protocol, bundle)  loop, park-boundary
                          │            durability)
                          └─────┬──────┘
                shared, engine-agnostic modules:
                turn step body · dispatch bodies · session
                lifecycle · park playbook helpers · harness StepFn
```

### The Loop contract

The client-facing surface every route, channel, and subagent dispatch
consumes (via `Runtime`):

```ts
interface Loop {
  /** Begin a durable session program. Mints the session id. */
  start(input: LoopStartInput): Promise<{ sessionId: string }>;

  /**
   * Deliver a typed signal to whatever is waiting on `token`.
   * Unifies today's six resumeHook families: deliveries, auth
   * callbacks, runtime-action results, turn control, cancellation.
   * Throws NoActiveWaiterError when nothing owns the token.
   */
  signal(token: string, payload: LoopSignal): Promise<{ sessionId: string }>;

  /** Resolve which session owns a token, without delivering. */
  resolveWaiter(token: string): Promise<{ sessionId: string } | undefined>;

  /**
   * Append-only event log read. `startIndex` counts events (not
   * transport chunks); negative values read relative to the tail.
   */
  events(
    sessionId: string,
    options?: { startIndex?: number },
  ): Promise<ReadableStream<HandleMessageStreamEvent>>;
}
```

Plus an eve-owned error taxonomy (`NoActiveWaiterError`,
`SessionNotFoundError`, `SessionExpiredError`) replacing the engine error
classes and string matching. `Runtime` becomes `createLoopRuntime(loop)`;
`CreateRuntime` becomes genuinely injected.

Two program-facing contracts replace engine value types in shared step
signatures:

```ts
/** Replaces parentWritable: WritableStream<Uint8Array>. */
interface TurnEventSink {
  write(event: HandleMessageStreamEvent): Promise<void>;
}
// Cancellation: each step invocation receives a fresh AbortSignal
// constructed by the Loop implementation; it is never serialized.
```

### The durability contract

The unit of durability is the committed step result: after the legacy
stream fallback is deleted, `DurableSessionState` is a pure value codec
(versioned snapshot + migration chain) with no read dependency on the
engine. The Loop contract then requires only:

1. committed session state survives to the next resume,
2. `signal(token)` reaches the active waiter or fails `NoActiveWaiter`
   (resume-or-start in `channel/send.ts` depends on exactly this),
3. the event log is append-only and readable by event index.

How much intra-turn progress survives a crash is a per-implementation
property: the workflow Loop replays journaled steps; the in-process Loop
guarantees park-boundary durability only (a crashed in-flight turn resumes
from the last committed state when the next signal arrives). That is
sufficient for dev and tests; production stays on the workflow Loop.

### Control flow stays per-implementation

The session/turn driver choreography is deliberately **not** shared code.
Hosting models differ too radically — a replayed VM program with hooks
versus a plain long-lived async function — and a shared driver would become
the next leaky middle layer. Instead eve shares:

- the state-machine vocabulary (`NextDriverAction` collapses into the
  harness's own result type, see below; `RuntimeActionRequest/Result`,
  `InputRequest/Response`),
- the step bodies (`turnStep`'s body, the dispatch bodies, session
  create/settle/terminal-failure logic) as plain functions,
- pure transition helpers (delivery coalescing, HITL child routing,
  park playbook).

Each Loop composes these with its own control flow. A shared conformance
scenario suite — the same fixtures run against both Loops asserting
identical event streams and terminal results — guards semantic equivalence
instead of shared code.

### Harness owns its result vocabulary

`StepNext` gains explicit park reasons so no layer re-derives them:

```ts
type StepNext =
  | StepFn // continue immediately
  | StepDone // terminal
  | { park: "input" } // HITL batch pending
  | { park: "authorization"; names: readonly string[] }
  | { park: "runtime-actions"; keys: readonly string[] }
  | { park: "sandbox-interrupt"; keys: readonly string[] }
  | { park: "cancelled" };
```

`derivePendingState` is deleted; `DurableStepResult` becomes a thin
serialization of this union; the driver playbook keys off it directly. The
three harness engine tendrils move behind injected config: an attributes
writer, a transport-error classifier (relocating `workflow-stream-error.ts`
into the workflow Loop), and the emitter's chunk policy.

### What moves under `loop/vercel-workflow/`

`workflow-entry`, `turn-workflow`, `workflow-steps`' step wrappers (bodies
stay shared), `turn-dispatch`, `turn-control-*`, `session-delivery-hook`,
`hook-ownership`, `turn-cancellation-control`, `workflow-runtime`,
`ndjson-stream`, the deploy-drift migrations, and the whole of
`internal/workflow/` and `internal/workflow-bundle/` (the compiler asks the
active Loop for its build hooks). The build-time fragility documented there
(bundle string surgery, transform triplication, plugin monkeypatching)
becomes a private cost of one implementation rather than a property of eve.

## Preserved semantics

- Channel/client surfaces, protocol events, and HITL shapes are unchanged.
- Continuation tokens remain the public addressing scheme, with identical
  resume-or-start behavior (`NoActiveWaiterError` ⇔ today's normalized
  `HookNotFoundError`).
- Task vs conversation park rules, subagent delegation and HITL proxying,
  cancellation cascades, and session token limits are unchanged.
- `sessionId` remains the stream/inspection key; the workflow Loop keeps
  minting it from the run id, other Loops mint their own.

## Plan

**Phase 0 — deletions (no new abstractions).** Remove the legacy driver
path (`runLegacyTurnWorkflow`, `dispatch-*` arms, `driverCapabilities`,
`eve.session` fallback). Merge the two runtime-action dispatch arms.
De-duplicate helper copies; consolidate the four park stores behind one
pending-state module. Rename `harness/workflow-*` (sandbox tool) →
`codemode-*`, and `runtime/sessions/runtime-session.ts` → deployment-cache
naming.

**Phase 1 — contract tightening.** Harness park reasons in `StepNext`;
delete `derivePendingState`; collapse `DurableStepResult`. Inject the
attributes writer, transport-error classifier, and emitter policy. Replace
`parentWritable`/serialized `AbortSignal` with `TurnEventSink` + per-step
signals.

**Phase 2 — seam hygiene.** Replace the `export *` engine re-export with
the `Loop` interface and eve-owned errors; route
`session-callback-route`, `connections/callback-route`, and
`subagent-adapter` through `Loop.signal`. Fix the runtime↔execution
layering inversions (sandbox executors, skills instructions, subagent
adapter registration) to break both dependency cycles. Callback base URLs
from configuration; typed `eve.*` context keys; `createRuntime` injected.

**Phase 3 — quarantine and second Loop.** Move all workflow mechanics under
`loop/vercel-workflow/`. Implement `loop/in-process` against the same
contract. Land the shared conformance scenario suite; switch scenario tests
to the in-process Loop by default.

**Phase 4 — harness decomposition (separate effort, unblocked by Phase 1).**
Split `tool-loop.ts` (2,533 lines) along its natural seams: resume staging,
model call + recovery, result handling.

## Risks and open questions

- **Pinned-session breakage.** Phase 0 breaks sessions still running on
  older pinned drivers at their next resume. Accepted pre-1.0; release
  notes must say so.
- **Event-index cursor.** `Loop.events` defines `startIndex` in event
  counts. The workflow Loop must keep one transport chunk per event (the
  current ordered-emitter policy) or maintain an index mapping; this policy
  becomes part of that implementation's contract, not the harness's.
- **Single active Loop per deployment.** Parent and child sessions always
  share one Loop; cross-Loop delegation is out of scope.
- **In-process crash semantics.** Park-boundary durability must be stated
  plainly in docs: an in-flight turn does not survive a process crash on
  the in-process Loop.
- **Signal payload versioning.** `LoopSignal` replaces six ad-hoc hook
  payload shapes; the workflow Loop still needs one release of tolerance
  for in-flight hook payloads written by the previous shapes.
