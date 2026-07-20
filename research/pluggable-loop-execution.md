---
issue: TBD
last_updated: "2026-07-20"
status: proposed
---

# Pluggable loop execution

## Summary

eve should define an engine-neutral `Loop` contract so the current Workflow SDK runtime is one
implementation alongside a continuous single-process implementation and, eventually, a Temporal
implementation. A Loop owns durable session orchestration: accepting deliveries, persisting
checkpoints, scheduling kernel advances, waiting for signals, executing orchestration effects,
cancelling work, and retaining the event log. It does not own agent conversation semantics.

The agent conversation is an engine-neutral kernel. One kernel advance receives a serializable
checkpoint and normalized input, uses injected runtime services, and returns a tagged transition:
continue, suspend, complete, or fail. The Loop persists the kernel checkpoint without inspecting
conversation history, pending input, authorization, compaction, sandbox continuations, or other
kernel internals.

Channels, HTTP routes, schedules, callbacks, and evals talk only to the Loop or an agent facade
composed over it. Workflow hooks, streams, directives, attributes, private registries, build
transforms, and deployment behavior live entirely inside `WorkflowLoop`. A `ProcessLoop` is the
first additional implementation and the proof that the boundary is real; Temporal work begins
only after `ProcessLoop` and `WorkflowLoop` pass the same conformance suite.

This proposal intentionally changes two existing semantics to simplify the portable contract:

- A session pins its agent program revision when it starts. Adopting a newer revision is explicit,
  not automatic on every turn.
- A delivery to a session with an active turn returns `busy`. The Loop does not perform
  timing-dependent coalescing or provide a general FIFO input queue.

## Motivation

The current `Runtime` interface looks like a substitution point, but Workflow mechanics escape it
in several directions:

- Nitro routes and schedules construct `createWorkflowRuntime()` directly.
- Local subagents construct a new Workflow runtime instead of reusing an injected runtime.
- Child HITL, authorization, terminal callbacks, OAuth callbacks, and cancellation call Workflow
  hooks directly.
- The harness returns a function, `null`, or a terminal value, so execution recovers the actual
  wait reason by inspecting hidden harness state.
- Checkpoints combine durable session state with serialized runtime context that reloads compiled
  behavior while decoding.
- Dynamic tools rely on Workflow's private registered-step global and transformed closure fields.
- Event writes, retries, attributes, stream errors, and legacy session recovery use Workflow
  behavior directly.
- The host and build pipeline always install Workflow routes, transforms, world plugins, and
  bundle output.

As a result, replacing the root runtime factory would still leave Workflow-backed children,
callbacks, signals, cancellation, persistence, and build output. A Temporal implementation would
have to reproduce the orchestration in `execution/workflow-steps.ts` and emulate Workflow hooks,
streams, globals, and deployment rules rather than implement a small eve-owned interface.

The current structure also creates correctness ambiguity independent of portability. Delivery
falls back to starting a new session after any resume error, public session identity is mixed with
one-shot wait capabilities, critical parent-child signaling runs through best-effort channel event
handlers, and concurrent delivery semantics depend on Workflow and transport timing.

## Goals

- Make Workflow SDK execution one `Loop` implementation with no Workflow dependencies in neutral
  channel, kernel, context, protocol, or runtime-service modules.
- Support a host-scoped continuous `ProcessLoop` without changing agent or channel code.
- Leave a contract that maps naturally to Temporal workflows, signals, activities, and workers.
- Define deterministic delivery, identity, event, retry, cancellation, and revision semantics.
- Replace hidden session-state protocols with explicit serializable transitions.
- Persist one versioned, data-only session snapshot and resolve executable behavior out of band.
- Separate runtime selection from agent behavior and isolate Loop-specific build contributions.
- Reuse the same conformance and eval corpus across Loop implementations.
- Delete compatibility paths, fake seams, and Workflow-specific translations made unnecessary by
  the new contracts.

## Non-goals

- A general plugin API for arbitrary third-party orchestration engines in the first change.
- Implementing Temporal as part of the initial extraction.
- Turning every model call, tool call, or runtime service into a universal effect language.
- Providing an ordered multi-message queue for active sessions.
- Preserving automatic latest-deployment adoption for existing sessions.
- Preserving pre-change in-flight Workflow sessions unless that is approved as a separate,
  time-bounded rollout requirement.
- Making authored channel event handlers part of orchestration correctness.

## Boundary model

```text
channel / HTTP / schedule / eval transport
                    |
                    v
              agent facade
                    |
                    v
             data-only Loop API
          /             |             \
 WorkflowLoop       ProcessLoop       TemporalLoop
          \             |             /
                    v
             agent kernel advance
                    |
                    v
 runtime services: agent catalog, models, tools, connections, sandbox
```

The boundaries have distinct ownership:

- **Transport adapters** authenticate callers and normalize transport input. They do not persist
  sessions or signal Workflow hooks.
- **The agent facade** composes channel addressing, session handles, and event access over a Loop.
- **The Loop** owns session orchestration, durable waits, effects, retries, cancellation, event
  ordering, and implementation lifecycle.
- **The agent kernel** owns conversation history, model/tool behavior, authored state, compaction,
  input and authorization semantics, and semantic events.
- **Runtime services** resolve executable behavior from stable IDs. They contain no durable
  orchestration behavior.
- **The host/build adapter** contributes engine-specific routes, workers, transforms, and
  deployment artifacts. Runtime and build selection are separate seams.

`src/harness` should be renamed to `src/kernel` or `src/agent-kernel`. It is production agent
execution, not a test harness. The current channel `Runtime` becomes `Loop`; process cache scopes
currently named `RuntimeSession` should receive a cache- or artifact-specific name.

## Identity model

The contract uses separate branded identities:

```ts
type SessionId = string & { readonly __brand: "SessionId" };
type SessionAddress = string & { readonly __brand: "SessionAddress" };
type SignalCapability = string & { readonly __brand: "SignalCapability" };
type DeliveryId = string & { readonly __brand: "DeliveryId" };
type SignalId = string & { readonly __brand: "SignalId" };
type EventCursor = string & { readonly __brand: "EventCursor" };
```

- `SessionId` is the stable, public, opaque identity of one session. It is not a Workflow run ID.
- `SessionAddress` is an optional channel-facing alias, such as a namespaced chat or thread key.
  At most one live session owns an address.
- `SignalCapability` is an internal, scoped capability for satisfying a particular durable wait.
  It is not a public session address and must not be accepted by ordinary delivery APIs.
- `DeliveryId` makes external acceptance idempotent.
- `SignalId` makes callbacks and internal signals idempotent.
- `EventCursor` is an eve-owned opaque position. Backends may use numeric indexes internally, but
  callers do not depend on Workflow `startIndex` behavior.

The public API must not require callers to supply both a session ID and an unrelated continuation
token. A route addresses a stable `SessionId` or a `SessionAddress`; internal callbacks use a
`SignalCapability`.

## Loop contract

The Loop is host-scoped. Routes and schedules receive lightweight facades over the same instance
rather than constructing a new backend client on every request.

```ts
export interface Loop {
  accept(command: AcceptCommand): Promise<AcceptResult>;

  signal(capability: SignalCapability, command: SignalCommand): Promise<SignalResult>;

  cancel(command: CancelCommand): Promise<CancelResult>;

  events(
    sessionId: SessionId,
    options?: ReadEventsOptions,
  ): Promise<ReadableStream<StampedAgentEvent>>;
}
```

`AcceptCommand` handles both unconditional starts and atomic deliver-or-start behavior:

```ts
export interface AcceptCommand {
  readonly address?: SessionAddress;
  readonly delivery: ExternalDelivery;
  readonly deliveryId: DeliveryId;
  readonly onMissing:
    { readonly kind: "reject" } | { readonly kind: "start"; readonly seed: SessionSeed };
}

export type AcceptResult =
  | {
      readonly status: "started" | "delivered" | "duplicate";
      readonly sessionId: SessionId;
    }
  | { readonly status: "busy"; readonly sessionId: SessionId }
  | { readonly status: "not_found" };
```

The command contains durable data only. `SessionSeed` names an agent revision, active node, mode,
channel ID and state, auth context, limits, parent identity, and optional terminal callback data. It
never contains a live `ChannelAdapter`, function, `WritableStream`, `AbortSignal`, compiled bundle,
or filesystem path.

`signal()` is deliberately separate from `accept()`:

```ts
export interface SignalCommand {
  readonly signalId: SignalId;
  readonly signal: InternalSignal;
}

export type SignalResult =
  | { readonly status: "accepted" | "duplicate"; readonly sessionId: SessionId }
  | { readonly status: "not_found" | "expired" | "conflict" };
```

Internal signals include effect results, child results, proxied child input or authorization,
authorization callbacks, and other framework-owned wait completions. The union is eve-owned and
does not mention hooks or backend primitives.

Session lookup and metadata inspection may remain small separate ports if needed. They must return
typed not-found outcomes; a synchronous helper that merely constructs a handle should be named
`sessionHandle`, not `getSession`.

## Delivery semantics

`accept()` has the following externally observable semantics:

1. Address resolution, duplicate detection, delivery, and optional creation are one atomic Loop
   operation.
2. A repeated `DeliveryId` returns `duplicate` and the original `SessionId`; it never executes the
   delivery twice.
3. An indeterminate storage, network, or backend error is propagated. It never falls through to
   starting a second session.
4. A delivery is accepted only while the session is waiting for external delivery. An active turn
   returns `busy`.
5. The Loop does not coalesce concurrent deliveries and does not expose timing-dependent acceptance
   at internal driver boundaries.
6. Channels that receive bursts queue in the channel or application layer and retry after the
   session emits `session.waiting`.
7. Input-response delivery uses `onMissing: { kind: "reject" }`; it never creates a replacement
   session after the target wait has expired.

The implementation may serialize work through a local mutex, a Workflow ownership record, or a
Temporal workflow. Those mechanisms are private as long as they satisfy the same outcomes.

## Agent kernel contract

The kernel exposes one serializable state-machine transition:

```ts
export interface AgentKernel {
  advance(
    checkpoint: KernelCheckpoint,
    input: KernelInput | undefined,
    context: KernelExecutionContext,
  ): Promise<KernelTransition>;
}

export type KernelTransition =
  | {
      readonly kind: "continue";
      readonly checkpoint: KernelCheckpoint;
    }
  | {
      readonly kind: "suspend";
      readonly checkpoint: KernelCheckpoint;
      readonly wait: WaitSpec;
      readonly effects?: readonly LoopEffect[];
    }
  | {
      readonly kind: "complete";
      readonly checkpoint: KernelCheckpoint;
      readonly output: unknown;
      readonly isError?: boolean;
      readonly usage?: SessionUsage;
    }
  | {
      readonly kind: "fail";
      readonly checkpoint: KernelCheckpoint;
      readonly error: SerializedError;
    };
```

The meanings are exact:

- `continue` asks the Loop to schedule another advance immediately without external input.
- `suspend` commits the checkpoint and waits for the declared condition. Effects are dispatched
  with stable IDs before or as part of establishing that wait.
- `complete` commits the terminal checkpoint and result.
- `fail` is a semantic terminal failure. An exception thrown by `advance()` is an unsuccessful
  execution attempt governed by the Loop retry policy, not an implicit terminal result.

`WaitSpec` is a tagged union, not state inferred by the driver:

```ts
export type WaitSpec =
  | { readonly kind: "delivery" }
  | { readonly kind: "effects"; readonly effectIds: readonly EffectId[] }
  | { readonly kind: "input"; readonly requestIds: readonly string[] }
  | { readonly kind: "authorization"; readonly challengeIds: readonly string[] };
```

Pending runtime actions, human input, authorization, normal conversation idle, and suspensible tool
execution therefore cannot collapse into the same `null` value.

`KernelExecutionContext` contains invocation-local capabilities such as runtime services, a typed
event sink, telemetry, and cancellation. These values are never serialized as part of a turn
input:

```ts
export interface KernelExecutionContext {
  readonly cancellation: AbortSignal;
  readonly events: EventSink;
  readonly runtime: RuntimeServices;
  readonly telemetry: ExecutionTelemetry;
}
```

The event sink is mandatory. Tests use an in-memory sink rather than selecting a different
non-streaming agent execution path.

## Checkpoint contract

The Loop persists one versioned snapshot:

```ts
export interface SessionSnapshot {
  readonly formatVersion: 1;
  readonly session: SessionMetadata;
  readonly program: {
    readonly agentId: string;
    readonly revision: string;
    readonly nodeId: string;
  };
  readonly channel: {
    readonly id: string;
    readonly state: DurableValue;
  };
  readonly kernel: KernelCheckpoint;
}
```

The kernel owns the schema and versioning of `KernelCheckpoint`; the Loop treats it as opaque
durable data. Loop-private wait, attempt, effect, address, and event-log records are stored by the
implementation and are not inserted into authored state.

Runtime ALS context is an ephemeral projection reconstructed for each advance. An `AgentCatalog`
resolves the pinned `{ agentId, revision, nodeId }` to executable code, and a channel catalog
resolves `channel.id` to behavior. Snapshot decoding never loads a bundle as a side effect and does
not depend on key ordering.

`DurableValue` is an eve-owned JSON-compatible value model plus explicit, versioned eve codecs.
Public state without a codec is validated against that model before checkpointing. Backend
serializers such as devalue, Workflow payload encoding, or Temporal data converters do not define
what authored durable state supports.

## Program revision semantics

Every new session pins an immutable program revision. Root sessions and local child sessions name
their revision in `SessionSeed`; a child normally inherits the parent's revision unless dispatch
explicitly targets another compiled agent.

Redeploying an application does not silently change instructions, tools, models, or executable
closure identity for an existing session. A future explicit upgrade operation may validate and
replace the pinned revision at a safe waiting boundary. Upgrade policy is outside the first Loop
contract.

This removes the requirement for a long-lived pinned driver that launches a latest-deployment
child workflow for every turn. It also gives Workflow, Temporal, and process implementations the
same deterministic code-resolution semantics.

## Effects and child sessions

The kernel may call ordinary models and tools directly through runtime services within one
retryable advance. `LoopEffect` is reserved for work whose lifecycle changes orchestration:

- Start a local child session.
- Dispatch a remote agent request.
- Post a terminal callback.
- Establish or complete another durable framework interaction.

Each effect has a stable `EffectId` and serializable input. Effect completion returns through a
`SignalCapability` and `SignalId`. The Loop deduplicates both dispatch and completion.

Local children are not channels. The Loop owns parent-child lineage, result delivery, cancellation,
and child input or authorization forwarding. Authored channel handlers may render child events but
cannot be required for the parent and child state machines to make progress.

The capital-`Workflow` sandbox tool becomes an ordinary suspensible tool implementation:

```ts
type ToolExecution =
  | { readonly kind: "completed"; readonly result: unknown }
  | {
      readonly kind: "suspended";
      readonly effects: readonly LoopEffect[];
      readonly continuation: DurableValue;
    };
```

It does not require a separate interrupt-state key, driver action, fake event coordinates, or
Workflow-specific dispatcher.

## Events and telemetry

`HandleMessageStreamEvent` remains the semantic event protocol after removing backend identifiers.
The Loop owns durable ordering and cursor assignment.

- Events are ordered within one session.
- Every persisted event receives an opaque `EventCursor`.
- Reading after a cursor is exclusive and deterministic.
- Terminal events remain replayable.
- Retrying one kernel advance does not create duplicate public events.
- Event append failures use eve-owned typed errors; the kernel never parses Workflow or Vercel
  transport strings.

The Loop supplies an idempotent `EventSink` for streaming events during an advance. It associates
events with a stable attempt and event identity so a backend retry can deduplicate them. Exact
storage transactions remain implementation-specific, but the conformance suite verifies public
ordering and deduplication.

Semantic token usage and budgets stay in the kernel checkpoint and terminal transition. Backend
run metadata uses an optional `ExecutionTelemetry` port. `WorkflowLoop` maps it to Workflow
attributes, Temporal may map it to search attributes, and `ProcessLoop` may store or ignore it.

Public protocol and health responses do not expose `workflowId`. A child event needs a child
`SessionId`; backend diagnostics, if retained, belong in an optional engine-neutral diagnostics
object outside the stable event contract.

## Retry, cancellation, and failure

The Loop applies an eve-owned attempt policy to thrown kernel and effect-runner failures. The same
policy and retry classification apply across implementations. Backend-native retry features may
implement the policy but do not define it.

- Kernel attempts receive a stable attempt identity.
- Effects and events carry stable idempotency identities across retries.
- Returned `fail` transitions are terminal and are not retried.
- Typed infrastructure failures may be retried according to policy.
- Unknown failures are not translated to not-found outcomes.
- Cancellation is observable through the invocation-local `AbortSignal` and persists as Loop
  state; it is not a Workflow hook imported by generic execution code.
- Cancelling a parent follows an explicit descendant policy implemented by the Loop.

Terminal callbacks are effects with idempotency and retry policy. Callback routes catch only typed
`not_found` or `expired` signal results; backend failures remain server errors.

## Channels

Channels remain responsible for transport-specific authentication, request parsing, external
address derivation, attachment acquisition, and presentation side effects. The Loop receives only
normalized durable deliveries and stable channel IDs.

One resolved authored channel should be represented once:

```ts
interface ResolvedChannel {
  readonly id: string;
  readonly adapter: ChannelBehavior;
  readonly routes: readonly ResolvedRoute[];
}
```

The host builds a route index separately. Resolution does not flatten the same channel behavior
into one mutable adapter per route, mutate a readonly adapter kind, or use process-global route
signatures and structural fingerprints to recover channel identity.

Channel event handlers remain presentation observers. Their failure policy may be best-effort, but
they do not own child signaling, callbacks, durable state-machine transitions, or other control
plane work.

## Runtime services and resource lifetime

Runtime services resolve behavior for one kernel advance:

```ts
interface RuntimeServices {
  readonly agents: AgentCatalog;
  readonly models: ModelResolver;
  readonly tools: ToolRegistry;
  readonly connections: ConnectionRegistry;
  readonly sandbox: SandboxRuntime;
}
```

They expose eve-owned contracts rather than Workflow or third-party public types. Dynamic tools
reference stable eve executable IDs plus serializable captured data; the catalog maps those IDs to
functions for the pinned program revision. No neutral module reads Workflow's registered-step
global, hidden transformed closure fields, ambient generation context, or artifact path substrings.

Context providers gain finalizers. Step-scoped resources are disposed in reverse order under
`finally`; host- or session-scoped resources are owned and closed by the `LoopHost`. This is
required for a continuous process implementation where leaked MCP clients and other resources
remain alive indefinitely.

## Runtime and build selection

Runtime lifecycle and deployment generation are separate internal interfaces:

```ts
interface LoopFactory {
  create(context: LoopHostContext): Promise<Loop>;
}

interface LoopBuildAdapter {
  prepare(context: BuildContext): Promise<LoopHostArtifacts>;
  configureNitro(context: NitroContext, artifacts: LoopHostArtifacts): void;
  emitDeployment(context: EmitContext, artifacts: LoopHostArtifacts): Promise<void>;
}
```

`LoopHostArtifacts` are opaque to neutral compiled-agent artifacts. A process implementation may
have no build contribution. Workflow's world plugin, queue namespace, routes, bundle builder,
dynamic-tool transform, and Nitro transform patch live behind the Workflow build adapter.

Loop selection is project or host deployment configuration, not part of `AgentDefinition` or the
compiled agent manifest. Workflow world selection moves with it. The current Workflow
implementation remains the default while the extraction is underway.

## WorkflowLoop

`WorkflowLoop` owns every Workflow SDK concern:

- `start`, hook creation and resumption, run lookup, and cancellation.
- Workflow and step directives.
- Workflow streams and event cursor mapping.
- Workflow attributes and typed error normalization.
- World selection, route mounting, transforms, and deployment bundles.
- Any explicitly approved compatibility reader for pre-change sessions.

Generic callbacks, subagent dispatch, channels, context, and kernel modules receive a `Loop`; they
never import Workflow helpers. The adapter may maintain an eve-owned address and delivery record if
the underlying hook API cannot provide atomic `accept()` semantics directly.

Existing Workflow sessions should not force legacy action variants into the generic kernel or
snapshot. If a rolling transition is required, legacy decoding stays inside `WorkflowLoop`, has a
documented support window, and is deleted after that window.

## ProcessLoop

`ProcessLoop` is the first new implementation and the architecture test. It is host-scoped and
contains:

- A session registry and per-session serialization primitive.
- An atomic address and delivery-id index.
- A worker queue that repeatedly calls `AgentKernel.advance()`.
- Durable wait and signal-capability records.
- An effect runner and child-session relationships.
- A checkpoint and event store.
- Cancellation and lifecycle shutdown.

The first conformance implementation may use in-memory stores. Local continuous execution then
uses the same interfaces with filesystem-backed stores and restart recovery. It requires no
Workflow transform, route namespace, directive, or global registry.

A `ProcessLoop` that can only run root sessions, or that delegates children and callbacks back to
Workflow, does not satisfy the proposal.

## Temporal compatibility

Temporal is not implemented in the first phase, but the contract must map without emulation:

- A session maps to a Temporal workflow identity.
- External delivery and internal capabilities map to distinct signals or updates.
- Kernel advances and effects map to activities or other retryable execution units.
- The pinned program revision maps to a versioned worker deployment.
- Cancellation and parent-child relationships use Temporal-native lifecycle behavior.
- Event retention may use an eve event store or a Temporal-compatible projection, while preserving
  eve cursor semantics.

If Temporal requires interpreting harness state, live channel functions, Workflow-style stream
indexes, or registered-step globals, the extraction is incomplete.

## Testing and conformance

A parameterized Loop conformance suite runs unchanged against `ProcessLoop`, `WorkflowLoop`, and
future implementations. It covers:

- Start, immediate continuation, waiting, resumption, completion, and terminal failure.
- Atomic deliver-or-start and definitive not-found behavior.
- Duplicate delivery and signal idempotency.
- Active-turn `busy` behavior and external retry.
- Input and authorization waits.
- Local child start, result, proxied HITL, and descendant cancellation.
- Remote effect and callback retries without duplicate dispatch.
- Event ordering, cursor replay, reconnect, and retry deduplication.
- Kernel attempt retry and terminal failure distinction.
- Process restart from a committed snapshot.
- Pinned program revision behavior.
- Conversation and task-mode terminal semantics.

The ordinary integration configuration no longer installs Workflow transforms globally. Workflow
tests use a dedicated configuration; kernel and `ProcessLoop` tests do not load Workflow at all.

The eval runner depends on one `AgentTransport` interface that owns new-session, attach, watch, and
cancel behavior. HTTP and in-process transports run the same eval corpus. Scenario tests use the
shipped client plus a small development-auth helper rather than maintaining a second streaming
client.

An AST-backed structural test enforces dependency direction. Outside the Workflow implementation
and build adapter, it rejects:

- Workflow package and internal imports, including dynamic imports.
- `"use workflow"` and `"use step"` directives.
- Workflow private global symbols and transformed closure fields.
- Imports from Loop implementations into neutral channel, kernel, context, protocol, and runtime
  service modules.

There is no allowlist for neutral modules.

## Migration

### 1. Fix the semantic contract

Introduce branded identities, atomic `accept()`, typed signal outcomes, active-turn `busy`
behavior, opaque event cursors, pinned program revisions, and an eve-owned durable-value contract.
Update public execution documentation with the breaking behavior.

### 2. Extract the kernel protocol

Replace `StepFn | null | StepDone` with `KernelTransition`, introduce explicit waits, make the event
sink mandatory, and move framework control state out of authored state. Consolidate durable session
state and serialized runtime context into `SessionSnapshot`.

### 3. Unify effects and suspension

Route local children, remote dispatch, callbacks, input, authorization, and the capital-`Workflow`
tool through the same effect, signal, and wait contracts. Remove critical orchestration from
channel event handlers.

### 4. Establish WorkflowLoop

Adapt current production execution to the new Loop and kernel contracts. Inject the same
host-scoped Loop into routes, schedules, children, callbacks, cancellation, and event access. Move
SDK imports, directives, streams, attributes, dynamic executable registration, and error handling
under the Workflow implementation.

### 5. Build ProcessLoop and the conformance suite

Implement every root and child lifecycle path without Workflow. Run the same conformance tests and
eval transport against both implementations. Treat failures to express behavior through the shared
contract as contract defects, not reasons for process-specific escape hatches.

### 6. Extract host/build integration

Move Workflow world selection out of agent definitions, isolate its Nitro and bundle
contributions, and allow process execution to build without Workflow artifacts.

### 7. Delete compatibility and fake seams

Remove the legacy turn driver, driver-capability migration, old Workflow stream snapshot fallback,
unused runtime factory option, unused result types, Workflow sandbox dispatcher, Workflow stream
error parser, private dynamic-tool replay, and backend IDs in the public protocol. Rename the
remaining neutral modules around their actual responsibilities.

Temporal implementation begins only after both existing implementations pass the shared suite and
the structural boundary test reports no neutral Workflow dependency.

## Deletion opportunities

The new contracts should remove rather than relocate the following complexity:

- `StepFn`, `StepNext`, `derivePendingState`, and special null-state inspection.
- The capital-`Workflow` runtime-action dispatcher and its extra driver arms.
- `runLegacyTurnWorkflow`, v0 driver migration, optional snapshots, and Workflow stream fallback.
- The dead `createRuntime` node-step option and unused channel `RunResult`.
- Workflow transport-error string parsing in the kernel.
- Private Workflow registered-step and synthetic replay machinery in neutral dynamic tools.
- Workflow IDs in health and child events.
- Process-global channel route signatures and structural identity fallbacks after channel
  aggregation.
- Ambient `NODE_ENV=test` model substitution and production fixture interpretation in favor of
  explicit mock models.
- The duplicate development scenario client in favor of the shipped client.

Compatibility code that must temporarily remain belongs exclusively to `WorkflowLoop` and must not
expand the generic Loop or kernel contracts.

## Acceptance criteria

The architecture is complete when:

- Selecting `ProcessLoop` replaces root execution, children, callbacks, waits, cancellation,
  checkpoints, and event replay without changes to channels or the agent kernel.
- Neutral modules contain no Workflow import, directive, private symbol, stream type, error parser,
  run ID, or deployment selector.
- Every Loop command and transition crossing a durable boundary contains serializable data only.
- The execution driver never inspects kernel-private state to decide what happens next.
- External delivery is atomic, idempotent, and deterministic under concurrency and backend errors.
- Session IDs, external addresses, and internal signal capabilities cannot be interchanged.
- The same conformance and eval suites pass against Workflow and process implementations.
- A process deployment builds and runs without generating or loading Workflow artifacts.
- Existing compatibility branches and fake abstraction seams are deleted or isolated behind a
  documented, expiring Workflow-only migration.

At that point Workflow is one Loop implementation rather than the architecture of eve execution.
