import type { StepFlowTypes, StepOutcome, StepPorts } from "#core/step-ports.js";

/**
 * The two pre-call stages of one intra-turn step, written against the
 * dependency ports in `step-ports.ts`: every branch, loop, and ordering
 * here is core-owned; the ports supply primitives and facets only.
 *
 * 1. {@link resolveTurnInput} — folds the delivery, deferred input, child
 *    results, and HITL responses into the state. The only pre-call stage
 *    that can settle the step without a model call.
 * 2. {@link assemblePrompt} — the context-engineering pipeline. Performs
 *    effects (staging, model resolution, compaction) but never settles;
 *    its failures are throws handled by the caller.
 */

/** The outcome of {@link resolveTurnInput}: settle the step, or proceed. */
export type TurnInputResolution<S extends StepFlowTypes> =
  | { readonly kind: "settled"; readonly outcome: StepOutcome<S> }
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
  readonly history: readonly S["historyEntry"][];
  readonly state: S["state"];
}

/**
 * Pre-call stage 1: resolves everything the turn is waiting on before a
 * prompt can exist. Reads top to bottom: deferred input replay; pending
 * runtime actions; stale-response conversion; pending HITL input; the
 * turn preamble; the session-limit continuation. Each wait that has no
 * resume payload yet settles the step as parked.
 */
export async function resolveTurnInput<S extends StepFlowTypes>(
  ports: StepPorts<S>,
  input: {
    readonly input: S["stepInput"] | undefined;
    readonly state: S["state"];
    /** The open turn trace, tagged with the turn id once the preamble emits. */
    readonly trace: S["turnTrace"] | undefined;
  },
): Promise<TurnInputResolution<S>> {
  let state = input.state;
  let emissionState = ports.facets.readEmission(state);

  const deferred = ports.waits.consumeDeferredInput({ input: input.input, state });
  state = deferred.state;

  const actions = await ports.waits.resolveRuntimeActions({ input: deferred.input, state });
  if (actions.outcome === "unresolved") {
    return settled(ports.settle.parked({ state: actions.state }));
  }
  state = actions.state;

  const stale = ports.waits.convertStaleResponses({
    history: actions.history,
    input: deferred.input,
    state,
  });

  const pending = ports.waits.resolvePendingInput({
    history: actions.history,
    input: stale.effectiveInput,
    state,
  });
  if (pending.outcome === "unresolved") {
    // A parked delivery that carried a deferred message still opens and
    // closes its turn so the delivery is visible on the event stream.
    if (
      ports.events !== undefined &&
      pending.deferredMessage === true &&
      ports.facets.hasDelivery(input.input)
    ) {
      emissionState = await ports.events.turnPreamble({ emissionState, input: stale.displayInput });
      emissionState = await ports.events.turnEpilogue({ emissionState, state: pending.state });
      return settled(ports.settle.parked({ emissionState, state: pending.state }));
    }

    return settled(ports.settle.parked({ state: pending.state }));
  }

  // Surface denied tool-call approvals as rejected action results. The
  // denial otherwise lives only in model history, so consumers (e.g.
  // observability) never see the tool call resolve.
  if (ports.events !== undefined && pending.rejectedApprovals !== undefined) {
    for (const result of ports.facets.approvalResultsOf(pending.rejectedApprovals)) {
      await ports.events.rejectedApproval({ batch: pending.rejectedApprovals, result });
    }
  }

  if (ports.events !== undefined && ports.facets.hasDelivery(input.input)) {
    emissionState = await ports.events.turnPreamble({ emissionState, input: stale.displayInput });

    if (input.trace !== undefined) {
      ports.trace.setAttribute(input.trace, "eve.turn.id", ports.facets.turnIdOf(emissionState));
    }
  }

  state = pending.state;

  // A resolved session-limit continuation prompt grants a fresh token
  // budget or ends the session.
  const continuation = await ports.waits.applyLimitContinuation({
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

function settled<S extends StepFlowTypes>(outcome: StepOutcome<S>): TurnInputResolution<S> {
  return { kind: "settled", outcome };
}

/**
 * Pre-call stage 2: the context-engineering pipeline. Assembles, in
 * order: the delivery's context entries; the staged delivery message; the
 * active model (dynamic-model dispatch, cache plan, attribution);
 * compaction; attachment hydration; the system channel (durable history
 * systems, dynamic instructions, skill announcements, the conditional
 * delivery instruction).
 *
 * Straight-line by contract: this stage never settles the step. Its
 * dependencies perform effects (staging, model resolution, compaction),
 * so failures throw to the caller's recovery path.
 */
export async function assemblePrompt<S extends StepFlowTypes>(
  ports: StepPorts<S>,
  resolved: ResolvedTurnInput<S>,
): Promise<S["prompt"]> {
  let state = resolved.state;
  const { emissionState } = resolved;
  let history = [...resolved.history];

  const contextEntries = ports.facets.contextEntriesOf(resolved.effectiveInput);
  if (contextEntries !== undefined && resolved.deferredContext !== true) {
    for (const entry of contextEntries) {
      history.push(ports.prompt.userEntry(entry));
    }
  }

  const deliveryContent = ports.facets.deliveryContentOf(resolved.effectiveInput);
  if (
    deliveryContent !== undefined &&
    resolved.deferredMessage !== true &&
    resolved.consumedMessage !== true
  ) {
    // Staging writes attachment bytes into the sandbox and returns
    // ref-only content, so the history never carries raw bytes across
    // step boundaries.
    history.push(ports.prompt.userEntry(await ports.prompt.stageAttachments(deliveryContent)));
  }

  // --- Active model ---------------------------------------------------------

  const ctx = ports.model.ambient();
  if (ctx !== undefined && ports.model.dispatchDynamicModel !== undefined) {
    await ports.model.dispatchDynamicModel({ ctx, emissionState, history, state });
  }
  const resolvedModel = await ports.model.resolve({ ctx, state });
  state = resolvedModel.state;
  const model = resolvedModel.model;
  const cachePlan = ports.model.cachePlan(model);
  const cacheMarker =
    cachePlan.kind === "anthropic-direct" ? ports.model.anthropicCacheMarker() : undefined;
  const attributionHeaders = ports.model.attributionHeaders(model);

  // --- Compaction -----------------------------------------------------------
  //
  // Runs before the call so the compacted entries flow through the same
  // history that rebuilds the durable state after the step.
  if (ports.compaction.shouldCompact(history, state)) {
    const compactionModel = await ports.compaction.resolveModel({ model, state });
    if (ports.events !== undefined) {
      await ports.events.compactionRequested({ compactionModel, emissionState, history, state });
    }
    history = [...(await ports.compaction.run({ compactionModel, history, state }))];
    history.push(...ports.compaction.postCompactionEntries());
    if (ports.events !== undefined) {
      await ports.events.compactionCompleted({ compactionModel, emissionState, state });
    }
  }

  // --- Model-facing projection ------------------------------------------------

  const emptyDeliveryEnabled =
    !ports.facets.hasOutputSchema(state) &&
    ctx !== undefined &&
    ports.model.isScheduleAuth(ctx) &&
    !ports.model.hasParentSession(ctx);

  // Hydration is transient: `history` itself stays ref-only so it can flow
  // into the durable state without bloating every future step boundary.
  const hydrated = await ports.prompt.hydrate(history);

  // Providers reject system entries in the message list — route them (and
  // every dynamic system source) onto the dedicated system channel.
  const systemEntries: S["historyEntry"][] = [];
  const modelEntries: S["historyEntry"][] = [];
  for (const entry of hydrated) {
    (ports.prompt.isSystemEntry(entry) ? systemEntries : modelEntries).push(entry);
  }
  if (ctx !== undefined) {
    systemEntries.push(...ports.prompt.dynamicInstructionEntries(ctx));
    const skillAnnouncement = ports.prompt.skillAnnouncementEntry(ctx);
    if (skillAnnouncement !== undefined) {
      systemEntries.push(skillAnnouncement);
    }
  }
  if (emptyDeliveryEnabled) {
    systemEntries.push(ports.prompt.conditionalDeliveryEntry());
  }

  return ports.prompt.finalize({
    attributionHeaders,
    cacheMarker,
    cachePath: cachePlan.path,
    ctx,
    emptyDeliveryEnabled,
    history,
    model,
    modelEntries,
    state,
    systemEntries,
  });
}
