/**
 * The two pre-call stages of one intra-turn step, expressed as core flow.
 *
 * Core owns the *sequence and branching* — where a step can settle before
 * a model call exists, which stages are straight-line, and what control
 * flags thread between them. Every payload (session state, message
 * history, prompts, emission coordinates) is opaque: implementations bind
 * them through {@link StepFlowTypes} and supply the effects through
 * {@link BeforeCallPorts}, mirroring how engines bind
 * {@link import("#core/types.js").LoopTypes}.
 *
 * 1. {@link resolveTurnInput} — folds the delivery, deferred input, child
 *    results, and HITL responses into the state. The only pre-call stage
 *    that can settle the step without a model call.
 * 2. {@link assemblePrompt} — the context-engineering pipeline. Performs
 *    effects (staging, model resolution, compaction) but never settles;
 *    its failures are throws handled by the caller.
 */

/**
 * The value shapes one step's pre-call flow is generic over. Core never
 * inspects them; the implementation binds concrete types once.
 */
export interface StepFlowTypes {
  /** One model call's raw result before settlement. */
  readonly callResult: unknown;
  /** The prepared model-call runner one step drives. */
  readonly callRunner: unknown;
  /** Emission coordinates threaded through lifecycle events. */
  readonly emissionState: unknown;
  /** The durable message history that becomes the base prompt. */
  readonly history: unknown;
  /** A resolved session-limit continuation grant, when one arrived. */
  readonly limitGrant: unknown;
  /** The resolved model call environment (model, cache path, headers). */
  readonly modelEnvironment: unknown;
  /** The step's terminal classification, produced only by ports. */
  readonly outcome: unknown;
  /** The assembled prompt: everything one model call consumes. */
  readonly prompt: unknown;
  /** Denied tool-call approvals surfaced back to consumers. */
  readonly rejectedApprovals: unknown;
  /** The session state. */
  readonly state: unknown;
  /** One step's input payload. */
  readonly stepInput: unknown;
  /** The observability trace of one turn, opened on its first step. */
  readonly turnTrace: unknown;
}

/** The outcome of {@link resolveTurnInput}: settle the step, or proceed. */
export type TurnInputResolution<S extends StepFlowTypes> =
  | { readonly kind: "settled"; readonly outcome: S["outcome"] }
  | ({ readonly kind: "resolved" } & ResolvedTurnInput<S>);

/** Everything prompt assembly needs once input resolution has succeeded. */
export interface ResolvedTurnInput<S extends StepFlowTypes> {
  /** The delivery message already rode an input response; do not append it again. */
  readonly consumedMessage?: boolean;
  /** Context entries were deferred to a later step; do not append them now. */
  readonly deferredContext?: boolean;
  /** The delivery message was deferred to a later step; do not append it now. */
  readonly deferredMessage?: boolean;
  /** Step input after deferred-input replay and stale-response conversion. */
  readonly effectiveInput: S["stepInput"] | undefined;
  readonly emissionState: S["emissionState"];
  /** History with pending input folded in — the base prompt. */
  readonly history: S["history"];
  readonly state: S["state"];
}

/**
 * The effect operations the pre-call flow is written against. Control
 * tags (`unresolved`, `deferredMessage`, …) are core vocabulary; every
 * other value passes through opaquely.
 */
export interface BeforeCallPorts<S extends StepFlowTypes> {
  // --- Stage 1: turn-input resolution -------------------------------------

  /** Whether lifecycle events can be emitted at all this step. */
  readonly emissionEnabled: boolean;
  /** Reads the emission coordinates persisted on the state. */
  readEmissionState(state: S["state"]): S["emissionState"];
  /** Replays input deferred by a previous step in place of fresh input. */
  consumeDeferredInput(input: {
    readonly input: S["stepInput"] | undefined;
    readonly state: S["state"];
  }): { readonly input: S["stepInput"] | undefined; readonly state: S["state"] };
  /**
   * Folds completed child-action results into the history. `unresolved`
   * means results are still outstanding: the step parks.
   */
  resolveRuntimeActions(input: {
    readonly input: S["stepInput"] | undefined;
    readonly state: S["state"];
  }): Promise<
    | { readonly outcome: "resolved"; readonly history: S["history"]; readonly state: S["state"] }
    | { readonly outcome: "unresolved"; readonly state: S["state"] }
  >;
  /**
   * Converts input responses addressed to requests that no longer exist
   * into a plain user message. `displayInput` is what lifecycle events
   * show; `effectiveInput` is what the model sees.
   */
  convertStaleResponses(input: {
    readonly history: S["history"];
    readonly input: S["stepInput"] | undefined;
    readonly state: S["state"];
  }): {
    readonly displayInput: S["stepInput"] | undefined;
    readonly effectiveInput: S["stepInput"] | undefined;
  };
  /**
   * Resolves the pending HITL input batch. `unresolved` parks the step;
   * `deferredMessage` marks that the delivery carried a message which
   * must wait for a later step.
   */
  resolvePendingInput(input: {
    readonly history: S["history"];
    readonly input: S["stepInput"] | undefined;
    readonly state: S["state"];
  }):
    | {
        readonly outcome: "resolved";
        readonly consumedMessage?: boolean;
        readonly deferredContext?: boolean;
        readonly deferredMessage?: boolean;
        readonly history: S["history"];
        readonly limitGrant: S["limitGrant"] | undefined;
        readonly rejectedApprovals: S["rejectedApprovals"] | undefined;
        readonly state: S["state"];
      }
    | {
        readonly outcome: "unresolved";
        readonly deferredMessage?: boolean;
        readonly state: S["state"];
      };
  /** Surfaces denied tool-call approvals as rejected action results. */
  emitRejectedApprovals(rejected: S["rejectedApprovals"] | undefined): Promise<void>;
  /** Opens the turn on the event stream. */
  emitTurnPreamble(input: {
    readonly emissionState: S["emissionState"];
    readonly input: S["stepInput"] | undefined;
  }): Promise<S["emissionState"]>;
  /** Closes the turn on the event stream without a model call. */
  emitTurnEpilogue(input: {
    readonly emissionState: S["emissionState"];
    readonly state: S["state"];
  }): Promise<S["emissionState"]>;
  /** Called once the turn is open on the resolved path. */
  onTurnStarted?(emissionState: S["emissionState"]): void;
  /**
   * Applies a resolved session-limit continuation: a non-null outcome
   * settles the step (denied continuation), otherwise the state carries
   * the fresh grant.
   */
  applyLimitContinuation(input: {
    readonly emissionState: S["emissionState"];
    readonly limitGrant: S["limitGrant"] | undefined;
    readonly state: S["state"];
  }): Promise<{ readonly outcome: S["outcome"] | null; readonly state: S["state"] }>;
  /**
   * Classifies a state that must wait as the step's parked outcome,
   * stamping the emission coordinates when the turn was opened.
   */
  classifyParked(input: {
    readonly emissionState?: S["emissionState"];
    readonly state: S["state"];
  }): S["outcome"];
  /** Whether the raw input carries a fresh delivery (opens a new turn). */
  hasDeliveryInput(input: S["stepInput"] | undefined): boolean;

  // --- Stage 2: prompt assembly --------------------------------------------

  /** Appends the delivery's context entries to the history. */
  appendDeliveryContext(input: {
    readonly history: S["history"];
    readonly input: S["stepInput"] | undefined;
    readonly skipContext: boolean;
  }): S["history"];
  /** Stages the delivery message's attachments and appends it. */
  stageDeliveryMessage(input: {
    readonly history: S["history"];
    readonly input: S["stepInput"] | undefined;
    readonly skipMessage: boolean;
  }): Promise<S["history"]>;
  /** Resolves the active model and its call environment. */
  resolveActiveModel(input: {
    readonly emissionState: S["emissionState"];
    readonly history: S["history"];
    readonly state: S["state"];
  }): Promise<{ readonly environment: S["modelEnvironment"]; readonly state: S["state"] }>;
  /** Compacts the history when it crosses the configured threshold. */
  compactIfNeeded(input: {
    readonly emissionState: S["emissionState"];
    readonly environment: S["modelEnvironment"];
    readonly history: S["history"];
    readonly state: S["state"];
  }): Promise<{ readonly history: S["history"]; readonly state: S["state"] }>;
  /** Hydrates attachments and composes the final model-facing prompt. */
  assembleModelPrompt(input: {
    readonly environment: S["modelEnvironment"];
    readonly history: S["history"];
    readonly state: S["state"];
  }): Promise<S["prompt"]>;
}

/**
 * Pre-call stage 1: resolves everything the turn is waiting on before a
 * prompt can exist. Reads top to bottom: deferred input replay; pending
 * runtime actions; stale-response conversion; pending HITL input; the
 * turn preamble; the session-limit continuation. Each wait that has no
 * resume payload yet settles the step as parked.
 */
export async function resolveTurnInput<S extends StepFlowTypes>(
  ports: BeforeCallPorts<S>,
  input: { readonly input: S["stepInput"] | undefined; readonly state: S["state"] },
): Promise<TurnInputResolution<S>> {
  let state = input.state;
  let emissionState = ports.readEmissionState(state);

  const deferred = ports.consumeDeferredInput({ input: input.input, state });
  state = deferred.state;

  const actions = await ports.resolveRuntimeActions({ input: deferred.input, state });
  if (actions.outcome === "unresolved") {
    return settled(ports.classifyParked({ state: actions.state }));
  }
  state = actions.state;

  const stale = ports.convertStaleResponses({
    history: actions.history,
    input: deferred.input,
    state,
  });

  const pending = ports.resolvePendingInput({
    history: actions.history,
    input: stale.effectiveInput,
    state,
  });
  if (pending.outcome === "unresolved") {
    // A parked delivery that carried a deferred message still opens and
    // closes its turn so the delivery is visible on the event stream.
    if (
      ports.emissionEnabled &&
      pending.deferredMessage === true &&
      ports.hasDeliveryInput(input.input)
    ) {
      emissionState = await ports.emitTurnPreamble({ emissionState, input: stale.displayInput });
      emissionState = await ports.emitTurnEpilogue({ emissionState, state: pending.state });
      return settled(ports.classifyParked({ emissionState, state: pending.state }));
    }

    return settled(ports.classifyParked({ state: pending.state }));
  }

  await ports.emitRejectedApprovals(pending.rejectedApprovals);

  if (ports.emissionEnabled && ports.hasDeliveryInput(input.input)) {
    emissionState = await ports.emitTurnPreamble({ emissionState, input: stale.displayInput });
    ports.onTurnStarted?.(emissionState);
  }

  state = pending.state;

  const continuation = await ports.applyLimitContinuation({
    emissionState,
    limitGrant: pending.limitGrant,
    state,
  });
  if (continuation.outcome !== null) {
    return settled(continuation.outcome);
  }

  return {
    consumedMessage: pending.consumedMessage,
    deferredContext: pending.deferredContext,
    deferredMessage: pending.deferredMessage,
    effectiveInput: stale.effectiveInput,
    emissionState,
    history: pending.history,
    kind: "resolved",
    state: continuation.state,
  };
}

function settled<S extends StepFlowTypes>(outcome: S["outcome"]): TurnInputResolution<S> {
  return { kind: "settled", outcome };
}

/**
 * Pre-call stage 2: the context-engineering pipeline. Assembles, in
 * order: delivery context entries; the staged delivery message; the
 * active model environment; compaction; the final model-facing prompt.
 *
 * Straight-line by contract: this stage never settles the step. Its
 * ports perform effects (staging, model resolution, compaction), so
 * failures throw to the caller's recovery path.
 */
export async function assemblePrompt<S extends StepFlowTypes>(
  ports: BeforeCallPorts<S>,
  resolved: ResolvedTurnInput<S>,
): Promise<S["prompt"]> {
  let state = resolved.state;

  let history = ports.appendDeliveryContext({
    history: resolved.history,
    input: resolved.effectiveInput,
    skipContext: resolved.deferredContext === true,
  });

  history = await ports.stageDeliveryMessage({
    history,
    input: resolved.effectiveInput,
    skipMessage: resolved.deferredMessage === true || resolved.consumedMessage === true,
  });

  const model = await ports.resolveActiveModel({
    emissionState: resolved.emissionState,
    history,
    state,
  });
  state = model.state;

  ({ history, state } = await ports.compactIfNeeded({
    emissionState: resolved.emissionState,
    environment: model.environment,
    history,
    state,
  }));

  return await ports.assembleModelPrompt({ environment: model.environment, history, state });
}
