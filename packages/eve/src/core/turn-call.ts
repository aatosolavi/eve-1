import type { StepFlowTypes, StepOutcome, StepPorts } from "#core/step-ports.js";
import { assemblePrompt, resolveTurnInput } from "#core/turn-before-call.js";

/**
 * The call and after-call phases of one intra-turn step, and
 * {@link generateStep}, the complete step flow. Written against the
 * dependency ports in `step-ports.ts`: preflight order, the recovery
 * loop, the failure decision tree, usage-accounting order, and the trace
 * envelope are all core-owned.
 */

/**
 * One complete generate step inside its observability envelope: the first
 * step of a turn opens the turn trace and stamps it onto the state so
 * continuation steps restore the parent; every step runs the flow inside
 * the trace context. This is the core shape of the `generate` port
 * implementations.
 */
export async function generateStep<S extends StepFlowTypes>(
  ports: StepPorts<S>,
  input: { readonly input: S["stepInput"] | undefined; readonly state: S["state"] },
): Promise<StepOutcome<S>> {
  const trace = ports.facets.hasDelivery(input.input)
    ? ports.trace.start("ai.eve.turn", turnAttributes(ports, input.state))
    : undefined;
  try {
    const state =
      trace === undefined ? input.state : ports.trace.bind({ state: input.state, trace });
    return await ports.trace.inContext({ state, trace }, () =>
      runStepFlow(ports, { input: input.input, state, trace }),
    );
  } finally {
    if (trace !== undefined) {
      ports.trace.end(trace);
    }
  }
}

function turnAttributes<S extends StepFlowTypes>(
  ports: StepPorts<S>,
  state: S["state"],
): Record<string, string> {
  const attributes: Record<string, string> = {
    "eve.version": ports.identity.eveVersion,
    "eve.environment": ports.identity.environment,
    "eve.session.id": ports.facets.sessionIdOf(state),
  };
  if (ports.identity.functionId !== undefined && ports.identity.functionId !== "") {
    attributes["ai.telemetry.functionId"] = ports.identity.functionId;
  }
  return attributes;
}

async function runStepFlow<S extends StepFlowTypes>(
  ports: StepPorts<S>,
  input: {
    readonly input: S["stepInput"] | undefined;
    readonly state: S["state"];
    readonly trace: S["turnTrace"] | undefined;
  },
): Promise<StepOutcome<S>> {
  // --- Pre-call stage 1: turn-input resolution (may settle) ----------------

  const resolution = await resolveTurnInput(ports, input);
  if (resolution.kind === "settled") {
    return resolution.outcome;
  }
  const { emissionState } = resolution;

  // --- Pre-call stage 2: prompt assembly (straight-line) -------------------

  const prompt = await assemblePrompt(ports, resolution);

  // --- Call preflight (may settle) ------------------------------------------

  // The first attempt's input resolves before step.started so dynamic tool
  // resolvers subscribed to step.started observe the resolved toolset.
  const runner = ports.call.create({ emissionState, prompt });
  const attempt = ports.call.prepareAttempt(runner);

  if (ports.events !== undefined) {
    await ports.events.stepStarted({ emissionState, prompt });
  }

  // Workflow continuations replay the sandbox after step.started so nested
  // action lifecycle events keep the active turn's emission coordinates.
  const interrupted = await ports.call.continueWorkflowInterrupt({
    emissionState,
    input: resolution.effectiveInput,
    prompt,
  });
  if (interrupted !== null) {
    return interrupted;
  }

  const limited = await ports.call.enforceTokenLimit({ emissionState, prompt });
  if (limited !== null) {
    return limited;
  }

  // --- Model call + in-process recovery -------------------------------------

  let result: S["callResult"];
  try {
    result = await ports.call.run({ attempt, runner });
  } catch (error) {
    ports.call.assertNotCancelled();
    const recovery = await recoverModelCall(ports, { error, runner });
    ports.call.assertNotCancelled();
    if (recovery.outcome === "failed") {
      return await settleCallFailure(ports, {
        emissionState,
        error: recovery.error,
        runner,
        trace: input.trace,
      });
    }
    result = recovery.result;
  }

  // --- After call ------------------------------------------------------------

  const accounted = ports.usage.accumulate({ result, runner });
  await ports.usage.publish({ runner, snapshot: accounted.snapshot });
  return await ports.settle.step({ emissionState, prompt, result, state: accounted.state });
}

/**
 * The staged in-process recovery loop: stages run in port order, a
 * recovered result short-circuits, and a failed stage may replace the
 * error and hand call-shape options to the next stage.
 */
async function recoverModelCall<S extends StepFlowTypes>(
  ports: StepPorts<S>,
  input: { readonly error: unknown; readonly runner: S["callRunner"] },
): Promise<
  | { readonly outcome: "recovered"; readonly result: S["callResult"] }
  | { readonly outcome: "failed"; readonly error: unknown }
> {
  let error = input.error;
  let retryOptions: S["retryOptions"] | undefined;
  for (const stage of ports.call.recoveryStages) {
    const outcome = await stage({ error, retryOptions, runner: input.runner });
    if (outcome.outcome === "recovered") {
      return outcome;
    }
    if (outcome.outcome === "failed") {
      error = outcome.error;
      retryOptions = outcome.retryOptions;
    }
  }
  return { error, outcome: "failed" };
}

/**
 * The failure decision tree for an unrecovered model call:
 *
 * - no event stream → raw rethrow (internal callers handle it);
 * - stream-write failure → park, regardless of mode;
 * - terminal → complete as failure (the task's error result in task mode,
 *   so a parent driver resumes with a failed subagent result instead of a
 *   successful empty output);
 * - task mode → rethrow when the durable step may retry, else fail the run
 *   (a task cannot park for user-driven recovery);
 * - conversation → park for a user retry.
 */
async function settleCallFailure<S extends StepFlowTypes>(
  ports: StepPorts<S>,
  input: {
    readonly emissionState: S["emissionState"];
    readonly error: unknown;
    readonly runner: S["callRunner"];
    readonly trace: S["turnTrace"] | undefined;
  },
): Promise<StepOutcome<S>> {
  const { emissionState, error, runner, trace } = input;

  if (trace !== undefined) {
    ports.trace.recordError(trace, error);
  }

  if (ports.events === undefined) {
    throw error;
  }
  const events = ports.events;
  const state = ports.call.currentState(runner);

  // A durable event-stream write failure reaches the call's catch only
  // because stream writes run inside the model-call try/catch — the model
  // call itself may have succeeded. Never attribute it to the provider.
  if (ports.failure.isStreamWriteFailure(error)) {
    const described = ports.failure.describeStreamWrite({ error, runner });
    ports.log.error(
      "workflow stream write failed — parking session for retry by the user",
      described.logFields,
    );
    const advanced = await events.recoverableFailedTurn({
      content: described.content,
      emissionState,
      state,
    });
    return ports.settle.parked({ emissionState: advanced, state });
  }

  const described = ports.failure.describe({ error, runner });
  const classification = ports.failure.classification(error);

  if (classification === "terminal") {
    if (described.recognizedTerminal !== undefined) {
      // Recognized configuration failure: log the concise actionable line
      // instead of the structured dump.
      ports.log.error(described.recognizedTerminal.message, described.recognizedTerminal.fields);
    } else {
      ports.log.error(
        described.upstreamMessage ?? "model call failed terminally",
        described.logFields,
      );
    }
    await events.failedStep({ content: described.content, emissionState, state });
    return ports.mode === "task"
      ? { action: "done", isError: true, output: described.taskOutput, state }
      : { action: "done", output: "", state };
  }

  if (ports.mode === "task") {
    if (classification === "recoverable" && !ports.failure.isRetryBudgetConsumed(error)) {
      // A task cannot park for user-driven recovery. Let the durable step
      // retry from committed state — but only for errors whose in-process
      // budget is untouched.
      ports.log.warn(
        described.upstreamMessage ??
          "model call failed recoverably in task mode — rethrowing for durable step retry",
        described.logFields,
      );
      throw error;
    }

    ports.log.error(
      described.upstreamMessage ?? "model call failed; failing the task run",
      described.logFields,
    );
    await events.failedStep({ content: described.content, emissionState, state });
    return { action: "done", isError: true, output: described.taskOutput, state };
  }

  ports.log.error(
    described.upstreamMessage ?? "model call failed — parking session for retry by the user",
    described.logFields,
  );
  const advanced = await events.recoverableFailedTurn({
    content: described.content,
    emissionState,
    state,
  });
  return ports.settle.parked({ emissionState: advanced, state });
}
