import type { LoopMode, TurnStepResult } from "#core/types.js";

/**
 * The durable-step entrypoint: the flow between one engine's durability
 * primitive and the in-memory step programs. Restores the runtime
 * context, completes pending authorizations carried by the delivery,
 * resolves the delivery through the channel adapter, runs the generate
 * step inside the context scope, and projects the outcome back onto the
 * serialized cursors the engine persists.
 *
 * Same construction as `step-ports.ts`: every branch, loop, and ordering
 * is core-owned; the ports supply primitives and facets. The engine
 * above owns only the durable boundary and retry policy.
 */

/** The value shapes the entrypoint flow is generic over. */
export interface EntryFlowTypes {
  /** One completed-authorization record surfaced as a lifecycle event. */
  readonly authCompletion: unknown;
  /** One authorization callback carried by a delivery payload. */
  readonly authCallback: unknown;
  /** The restored runtime context. */
  readonly context: unknown;
  /** One delivery payload item. */
  readonly deliveryPayload: unknown;
  /** The parsed durable session the engine pre-read for this step. */
  readonly durableSession: unknown;
  /** The serialized durable session snapshot the engine persists. */
  readonly durableState: unknown;
  /** Emission coordinates read off the session for lifecycle events. */
  readonly emissionState: unknown;
  /** One event on the session stream. */
  readonly event: unknown;
  /** Messages handed to dynamic resolvers alongside an event. */
  readonly messages: unknown;
  /** The pending-authorization record stored on the durable state. */
  readonly pendingAuthorization: unknown;
  /** A run-scoped or agent-declared output schema. */
  readonly outputSchema: unknown;
  /** The serialized runtime-context snapshot the engine persists. */
  readonly serializedContext: unknown;
  /** The in-memory session. */
  readonly session: unknown;
  /** The resolved step input handed to the generate step. */
  readonly stepInput: unknown;
  /** The raw turn input: a delivery or folded-back child results. */
  readonly turnInput: unknown;
  /** Session-total usage reported on a completed turn. */
  readonly usage: unknown;
  /** The open writer of the session's event stream. */
  readonly writer: unknown;
}

/** The serialized cursors one engine persists across steps. */
export interface ProjectedState<E extends EntryFlowTypes> {
  readonly durable: E["durableState"];
  readonly serializedContext: E["serializedContext"];
}

/** The entrypoint's outcome: core's step vocabulary over the cursors. */
export type EntryOutcome<E extends EntryFlowTypes> = TurnStepResult<{
  readonly childResult: unknown;
  readonly delivery: unknown;
  readonly state: ProjectedState<E>;
  readonly usage: E["usage"];
}>;

/** The generate step's outcome over the in-memory session. */
export type SessionOutcome<E extends EntryFlowTypes> = TurnStepResult<{
  readonly childResult: unknown;
  readonly delivery: unknown;
  readonly state: E["session"];
  readonly usage: E["usage"];
}>;

/** The composed event handler threaded into the generate step. */
export type EntryEventHandler<E extends EntryFlowTypes> = (
  event: E["event"],
  messages?: E["messages"],
) => Promise<void>;

/** Authorization-completion primitives and facets. */
export interface AuthorizationDependencies<E extends EntryFlowTypes> {
  /** The authorization callback a payload carries, when it does. */
  callbackOf(payload: E["deliveryPayload"]): E["authCallback"] | undefined;
  /** Builds the authorization-completed lifecycle event. */
  completedEvent(input: {
    readonly completion: E["authCompletion"];
    readonly emissionState: E["emissionState"];
  }): E["event"];
  /** Clears the named pending authorizations from the durable session. */
  clearPending(durable: E["durableSession"], names: readonly string[]): E["durableSession"];
  /**
   * Matches one callback against the pending challenges. `undefined`
   * when no challenge carries the callback's connection name — the
   * payload is then consumed without completing anything.
   */
  match(
    pending: E["pendingAuthorization"],
    callback: E["authCallback"],
  ):
    | {
        readonly completion: E["authCompletion"];
        readonly name: string;
        readonly result: unknown;
      }
    | undefined;
  /** The pending-authorization record, when the state carries one. */
  pendingOf(durable: E["durableSession"]): E["pendingAuthorization"] | undefined;
  /** Stashes matched results on the context for tools to complete auth. */
  stash(ctx: E["context"], results: readonly unknown[]): void;
}

/** Channel-adapter primitives. */
export interface ChannelDependencies<E extends EntryFlowTypes> {
  /** Merges two resolved step inputs of one coalesced delivery. */
  coalesce(first: E["stepInput"], second: E["stepInput"]): E["stepInput"];
  /**
   * Runs the adapter's deliver hook for one payload. `null`/`undefined`
   * means the adapter handled the payload inline.
   */
  deliver(
    ctx: E["context"],
    payload: E["deliveryPayload"],
  ): Promise<E["stepInput"] | null | undefined>;
  /** Pins adapter-state mutations back onto the context. */
  pinAdapterState(ctx: E["context"]): void;
  /** Runs the adapter's event handler, returning the event to emit. */
  transformEvent(ctx: E["context"], event: E["event"]): Promise<E["event"]>;
}

/** Runtime-context primitives. */
export interface ContextDependencies<E extends EntryFlowTypes> {
  /** Applies deliver-time auth ferried on the turn input. */
  applyDeliveryAuth(ctx: E["context"], turnInput: E["turnInput"] | undefined): void;
  modeOf(ctx: E["context"]): LoopMode;
  /** Seeds the callback base URL so hook URLs resolve during tools. */
  seedCallbackBaseUrl(ctx: E["context"], url: string): void;
}

/** Hook and dynamic-resolver dispatch primitives. */
export interface HookDependencies<E extends EntryFlowTypes> {
  dispatchDynamicInstructions(
    ctx: E["context"],
    event: E["event"],
    messages: E["messages"] | undefined,
  ): Promise<void>;
  dispatchDynamicModel(
    ctx: E["context"],
    event: E["event"],
    messages: E["messages"] | undefined,
  ): Promise<void>;
  dispatchDynamicSkills(
    ctx: E["context"],
    event: E["event"],
    messages: E["messages"] | undefined,
  ): Promise<void>;
  dispatchDynamicTools(
    ctx: E["context"],
    event: E["event"],
    messages: E["messages"] | undefined,
  ): Promise<void>;
  dispatchStreamHooks(ctx: E["context"], event: E["event"]): Promise<void>;
  /** Dynamic-model dispatch is suppressed for this event. */
  isStepStarted(event: E["event"]): boolean;
}

/** Output-schema facets; the precedence rules are core flow. */
export interface SchemaDependencies<E extends EntryFlowTypes> {
  /** The agent's declared function-output contract, when it has one. */
  agentSchemaOf(ctx: E["context"]): E["outputSchema"] | undefined;
  hasSchema(session: E["session"]): boolean;
  /** The run-scoped (client-supplied) schema on the turn's input. */
  runScopedOf(input: E["stepInput"] | undefined): E["outputSchema"] | undefined;
  withSchema(session: E["session"], schema: E["outputSchema"]): E["session"];
}

/** Session hydration, projection, and classification primitives. */
export interface SessionDependencies<E extends EntryFlowTypes> {
  /** Classifies a session that must wait as the parked outcome. */
  classifyParked(session: E["session"]): SessionOutcome<E>;
  hydrate(ctx: E["context"], durable: E["durableSession"]): E["session"];
  readEmission(session: E["session"]): E["emissionState"];
  /** Re-reads context-owned continuation-token changes onto the session. */
  reconcileToken(ctx: E["context"], session: E["session"]): E["session"];
  /** Re-applies turn-agent config before one generate step. */
  refresh(ctx: E["context"], session: E["session"]): E["session"];
  snapshot(session: E["session"]): E["durableState"];
}

/** Event-stream writer primitives; the lifecycle is core flow. */
export interface StreamDependencies<E extends EntryFlowTypes> {
  close(writer: E["writer"]): Promise<void>;
  open(): E["writer"];
  release(writer: E["writer"]): void;
  write(writer: E["writer"], event: E["event"]): Promise<void>;
}

/** Turn-input facets over the delivery/child-results union. */
export interface TurnInputFacets<E extends EntryFlowTypes> {
  /** Wraps folded-back child results as the step's input. */
  asChildResultInput(turnInput: E["turnInput"]): E["stepInput"];
  isChildResults(turnInput: E["turnInput"] | undefined): boolean;
  isDelivery(turnInput: E["turnInput"] | undefined): boolean;
  payloadsOf(turnInput: E["turnInput"]): readonly E["deliveryPayload"][];
  /** The delivery with its payload list replaced. */
  withPayloads(
    turnInput: E["turnInput"],
    payloads: readonly E["deliveryPayload"][],
  ): E["turnInput"];
}

/** The complete dependency surface of the durable-step entrypoint. */
export interface EntryPorts<E extends EntryFlowTypes> {
  readonly auth: AuthorizationDependencies<E>;
  readonly cancellation: {
    /** Throws when the turn's abort signal already fired. */
    assertNotAborted(): void;
    isCancellation(error: unknown): boolean;
  };
  readonly channel: ChannelDependencies<E>;
  readonly codec: {
    restore(serialized: E["serializedContext"]): Promise<E["context"]>;
    serialize(ctx: E["context"]): E["serializedContext"];
  };
  readonly contexts: ContextDependencies<E>;
  /** Runs one generate step for the session inside the active scope. */
  readonly generate: (input: {
    readonly ctx: E["context"];
    readonly handleEvent: EntryEventHandler<E>;
    readonly input: E["stepInput"] | undefined;
    readonly session: E["session"];
  }) => Promise<SessionOutcome<E>>;
  readonly hooks: HookDependencies<E>;
  readonly schema: SchemaDependencies<E>;
  readonly scope: {
    /** Runs `fn` inside the fully-initialized context scope. */
    run(
      ctx: E["context"],
      session: E["session"],
      fn: (enriched: E["session"]) => Promise<SessionOutcome<E>>,
    ): Promise<SessionOutcome<E>>;
  };
  readonly sessions: SessionDependencies<E>;
  readonly stream: StreamDependencies<E>;
  readonly turnInputs: TurnInputFacets<E>;
  readonly usage: {
    /** Records observability spans for folded-back child results. */
    recordChildSpans(turnInput: E["turnInput"]): void;
    /** The session-total usage reported on a completed turn. */
    sessionTotalsOf(session: E["session"]): E["usage"] | undefined;
  };
}

/** The engine-supplied inputs of one durable step. */
export interface StepEntryInput<E extends EntryFlowTypes> {
  /** Callback base URL, when the host resolved one. */
  readonly callbackBaseUrl: string | undefined;
  /** The parsed durable session the engine pre-read. */
  readonly durableSession: E["durableSession"];
  /** The persisted snapshot behind it, reused when nothing changed. */
  readonly durableSnapshot: E["durableState"];
  readonly serializedContext: E["serializedContext"];
  readonly turnInput: E["turnInput"] | undefined;
}

/**
 * Runs one durable step end to end: restore the context; complete
 * delivery-carried authorizations; resolve the delivery through the
 * adapter (re-parking without a model turn when the adapter handled it
 * inline); run the generate step inside the context scope with the
 * composed event handler; project the outcome onto the serialized
 * cursors. A turn cancellation settles as the `cancelled` arm over the
 * unchanged input cursors.
 */
export async function runStepEntrypoint<E extends EntryFlowTypes>(
  ports: EntryPorts<E>,
  input: StepEntryInput<E>,
): Promise<EntryOutcome<E>> {
  const ctx = await ports.codec.restore(input.serializedContext);

  if (input.callbackBaseUrl !== undefined) {
    ports.contexts.seedCallbackBaseUrl(ctx, input.callbackBaseUrl);
  }

  // --- Delivery-carried authorization completion ----------------------------
  //
  // A payload carrying a callback is consumed here: matched callbacks
  // complete their pending authorization (results stashed for tools,
  // completion events emitted once the scope is open); unmatched ones
  // are dropped. Only callback-free payloads continue to the adapter.
  let turnInput = input.turnInput;
  let durable = input.durableSession;
  let completions: readonly E["authCompletion"][] | undefined;
  const pending = ports.auth.pendingOf(durable);
  if (pending !== undefined && ports.turnInputs.isDelivery(turnInput)) {
    const results: unknown[] = [];
    const names: string[] = [];
    const completed: E["authCompletion"][] = [];
    const remaining: E["deliveryPayload"][] = [];
    for (const payload of ports.turnInputs.payloadsOf(turnInput)) {
      const callback = ports.auth.callbackOf(payload);
      if (callback === undefined) {
        remaining.push(payload);
        continue;
      }
      const match = ports.auth.match(pending, callback);
      if (match !== undefined) {
        completed.push(match.completion);
        names.push(match.name);
        results.push(match.result);
      }
    }
    if (results.length > 0) {
      ports.auth.stash(ctx, results);
      durable = ports.auth.clearPending(durable, names);
      completions = completed;
      turnInput =
        remaining.length > 0 ? ports.turnInputs.withPayloads(turnInput, remaining) : undefined;
    }
  }

  ports.contexts.applyDeliveryAuth(ctx, turnInput);

  const session = ports.sessions.hydrate(ctx, durable);

  // --- Delivery resolution ---------------------------------------------------

  let resolved: E["stepInput"] | undefined;
  if (ports.turnInputs.isDelivery(turnInput)) {
    const inputs: E["stepInput"][] = [];
    for (const payload of ports.turnInputs.payloadsOf(turnInput)) {
      const result = await ports.channel.deliver(ctx, payload);
      if (result !== undefined && result !== null) {
        inputs.push(result);
      }
    }
    resolved =
      inputs.length === 0
        ? undefined
        : inputs.reduce((first, second) => ports.channel.coalesce(first, second));
    // Pin adapter-state mutations so they survive the step boundary.
    ports.channel.pinAdapterState(ctx);
  } else if (ports.turnInputs.isChildResults(turnInput)) {
    ports.usage.recordChildSpans(turnInput);
    resolved = ports.turnInputs.asChildResultInput(turnInput);
  }

  // The adapter handled the delivery inline (e.g. an interaction that
  // only edits a message): re-park without a model turn, and skip the
  // snapshot write when the session itself is unchanged.
  if (ports.turnInputs.isDelivery(turnInput) && resolved === undefined) {
    const rekeyed = ports.sessions.reconcileToken(ctx, session);
    return withState(ports.sessions.classifyParked(rekeyed), {
      durable: rekeyed === session ? input.durableSnapshot : ports.sessions.snapshot(rekeyed),
      serializedContext: ports.codec.serialize(ctx),
    });
  }

  // --- The generate step inside the context scope ----------------------------

  const writer = ports.stream.open();

  const handleEvent: EntryEventHandler<E> = async (event, messages) => {
    const emitted = await ports.channel.transformEvent(ctx, event);
    await ports.stream.write(writer, emitted);
    await ports.hooks.dispatchStreamHooks(ctx, emitted);
    if (!ports.hooks.isStepStarted(emitted)) {
      await ports.hooks.dispatchDynamicModel(ctx, emitted, messages);
    }
    await ports.hooks.dispatchDynamicTools(ctx, emitted, messages);
    await ports.hooks.dispatchDynamicSkills(ctx, emitted, messages);
    await ports.hooks.dispatchDynamicInstructions(ctx, emitted, messages);
  };

  const mode = ports.contexts.modeOf(ctx);

  let outcome: SessionOutcome<E>;
  try {
    // A signal already aborted at entry (cancellation during an in-line
    // runtime-action wait) must settle before the park-resume stages run,
    // or the pending batch would re-park and later re-dispatch.
    ports.cancellation.assertNotAborted();
    outcome = await ports.scope.run(ctx, session, async (enriched) => {
      // Output-schema precedence: a run-scoped schema always wins; with
      // none, a task run adopts the agent's declared function-output
      // contract; a conversation enforces nothing; continuation steps
      // preserve whatever is already in effect.
      let prepared = enriched;
      const runScoped = ports.schema.runScopedOf(resolved);
      const agentSchema = ports.schema.agentSchemaOf(ctx);
      if (runScoped !== undefined) {
        prepared = ports.schema.withSchema(prepared, runScoped);
      } else if (
        mode === "task" &&
        !ports.schema.hasSchema(prepared) &&
        agentSchema !== undefined
      ) {
        prepared = ports.schema.withSchema(prepared, agentSchema);
      }

      if (completions !== undefined) {
        const emissionState = ports.sessions.readEmission(prepared);
        for (const completion of completions) {
          await handleEvent(ports.auth.completedEvent({ completion, emissionState }));
        }
      }

      return await ports.generate({
        ctx,
        handleEvent,
        input: resolved,
        session: ports.sessions.refresh(ctx, prepared),
      });
    });
  } catch (error) {
    if (!ports.cancellation.isCancellation(error)) {
      throw error;
    }
    ports.stream.release(writer);
    return {
      action: "cancelled",
      state: { durable: input.durableSnapshot, serializedContext: input.serializedContext },
    };
  }

  // --- Projection onto the serialized cursors --------------------------------

  // Re-read the continuation token in case a handler rekeyed it.
  const rekeyed = ports.sessions.reconcileToken(ctx, outcome.state);
  const projected: ProjectedState<E> = {
    durable: ports.sessions.snapshot(rekeyed),
    serializedContext: ports.codec.serialize(ctx),
  };

  if (outcome.action === "done") {
    await ports.stream.close(writer);
    return {
      action: "done",
      isError: outcome.isError,
      output: outcome.output,
      state: projected,
      usage: ports.usage.sessionTotalsOf(rekeyed),
    };
  }

  ports.stream.release(writer);
  return withState(outcome, projected);
}

/** Re-attaches the projected cursors to a session-typed outcome. */
function withState<E extends EntryFlowTypes>(
  outcome: SessionOutcome<E>,
  state: ProjectedState<E>,
): EntryOutcome<E> {
  switch (outcome.action) {
    case "cancelled":
      return { action: "cancelled", state };
    case "continue":
      return { action: "continue", state };
    case "dispatch-workflow-runtime-actions":
      return {
        action: "dispatch-workflow-runtime-actions",
        pendingRuntimeActionKeys: outcome.pendingRuntimeActionKeys,
        state,
      };
    case "done":
      return {
        action: "done",
        isError: outcome.isError,
        output: outcome.output,
        state,
        usage: outcome.usage,
      };
    case "park":
      return {
        action: "park",
        authorizationNames: outcome.authorizationNames,
        hasPendingAuthorization: outcome.hasPendingAuthorization,
        hasPendingInputBatch: outcome.hasPendingInputBatch,
        pendingRuntimeActionKeys: outcome.pendingRuntimeActionKeys,
        state,
      };
  }
}
