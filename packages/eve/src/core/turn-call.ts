import {
  assemblePrompt,
  resolveTurnInput,
  type BeforeCallPorts,
  type StepFlowTypes,
} from "#core/turn-before-call.js";
import type { LoopMode } from "#core/types.js";

/**
 * The call and after-call phases of one intra-turn step, and
 * {@link generateStep}, the complete step flow they compose with the
 * pre-call stages. Core owns every decision — which preflight checks can
 * settle the step, when a failed call parks versus fails versus rethrows
 * for a durable retry — while implementations supply the effects and all
 * failure content through {@link CallPorts}.
 */

/**
 * The core-relevant description of a failed model call, produced by
 * {@link CallPorts.classifyCallFailure}:
 *
 * - `stream-write` — the durable event-stream write failed, not the model
 *   call itself; always parks for a user retry, regardless of mode.
 * - `terminal` — retrying cannot help; the step completes as a failure.
 * - `recoverable` — worth another attempt. `retriableInTask` marks errors
 *   whose in-process retry budget is untouched, so a task run may rethrow
 *   for the durable step to retry from committed state.
 */
export type CallFailure =
  | { readonly kind: "stream-write" }
  | { readonly kind: "terminal" }
  | { readonly kind: "recoverable"; readonly retriableInTask: boolean };

/**
 * The effect operations of the call and after-call phases. The runner is
 * created once per step and carries the prepared call; every later port
 * receives it back opaquely.
 */
export interface CallPorts<S extends StepFlowTypes> {
  /** Done-versus-park semantics owner for failed calls. */
  readonly mode: LoopMode;
  /**
   * Creates the model-call runner and resolves the first attempt's input.
   * Runs before `emitStepStarted` so dynamic tool resolvers subscribed to
   * step.started observe the resolved toolset.
   */
  prepareModelCall(input: {
    readonly emissionState: S["emissionState"];
    readonly prompt: S["prompt"];
  }): S["callRunner"];
  /** Announces the step on the event stream. */
  emitStepStarted(runner: S["callRunner"]): Promise<void>;
  /**
   * Replays a pending workflow-interrupt continuation. A non-null outcome
   * settles the step without a model call.
   */
  continueWorkflowInterrupt(input: {
    readonly input: S["stepInput"] | undefined;
    readonly runner: S["callRunner"];
  }): Promise<S["outcome"] | null>;
  /**
   * Enforces the session token budget. A non-null outcome settles the
   * step without a model call.
   */
  enforceTokenLimit(runner: S["callRunner"]): Promise<S["outcome"] | null>;
  /** Runs one model call (with inline tool execution). */
  runModelCall(runner: S["callRunner"]): Promise<S["callResult"]>;
  /** Throws the implementation's cancellation error when the turn aborted. */
  assertNotCancelled(): void;
  /** Runs the staged in-process recovery pipeline over a failed call. */
  recoverModelCall(input: {
    readonly error: unknown;
    readonly runner: S["callRunner"];
  }): Promise<
    | { readonly outcome: "recovered"; readonly result: S["callResult"] }
    | { readonly outcome: "failed"; readonly error: unknown }
  >;
  /** Records the failure on the step's trace before any settlement. */
  recordCallFailure(error: unknown): void;
  /** Maps an unrecovered error onto the core failure vocabulary. */
  classifyCallFailure(error: unknown): CallFailure;
  /** Emits the recoverable failure and parks the step for a user retry. */
  parkAfterCallFailure(input: {
    readonly error: unknown;
    readonly failure: CallFailure;
    readonly runner: S["callRunner"];
  }): Promise<S["outcome"]>;
  /**
   * Emits the failed step and completes it. `asTaskError` marks the
   * completion as the task's error result so a parent driver resumes with
   * a failed subagent result instead of a successful empty output.
   */
  failStep(input: {
    readonly asTaskError: boolean;
    readonly error: unknown;
    readonly failure: CallFailure;
    readonly runner: S["callRunner"];
  }): Promise<S["outcome"]>;
  /** Observes (logs) the rethrow of a task-retriable failure. */
  onTaskRetryRethrow(input: { readonly error: unknown; readonly runner: S["callRunner"] }): void;
  /** Accumulates per-turn usage onto the state and writes observability tags. */
  accountUsage(input: {
    readonly result: S["callResult"];
    readonly runner: S["callRunner"];
  }): Promise<S["state"]>;
  /** Classifies the successful call into the step's outcome. */
  settleStep(input: {
    readonly result: S["callResult"];
    readonly runner: S["callRunner"];
    readonly state: S["state"];
  }): Promise<S["outcome"]>;
}

/** Every port one complete step flow drives. */
export type StepPorts<S extends StepFlowTypes> = BeforeCallPorts<S> & CallPorts<S>;

/**
 * One complete generate step: pre-call input resolution (may settle),
 * prompt assembly, call preflight (step announcement, workflow-interrupt
 * replay, token budget — the latter two may settle), the model call with
 * its recovery pipeline, and settlement. This is the core shape of the
 * `generate` port implementations.
 */
export async function generateStep<S extends StepFlowTypes>(
  ports: StepPorts<S>,
  input: { readonly input: S["stepInput"] | undefined; readonly state: S["state"] },
): Promise<S["outcome"]> {
  // --- Pre-call stage 1: turn-input resolution (may settle) ----------------

  const resolution = await resolveTurnInput(ports, input);
  if (resolution.kind === "settled") {
    return resolution.outcome;
  }

  // --- Pre-call stage 2: prompt assembly (straight-line) -------------------

  const prompt = await assemblePrompt(ports, resolution);

  // --- Call preflight (may settle) ------------------------------------------

  const runner = ports.prepareModelCall({ emissionState: resolution.emissionState, prompt });

  if (ports.emissionEnabled) {
    await ports.emitStepStarted(runner);
  }

  // Workflow continuations replay the sandbox after step.started so nested
  // action lifecycle events keep the active turn's emission coordinates.
  const interrupted = await ports.continueWorkflowInterrupt({
    input: resolution.effectiveInput,
    runner,
  });
  if (interrupted !== null) {
    return interrupted;
  }

  const limited = await ports.enforceTokenLimit(runner);
  if (limited !== null) {
    return limited;
  }

  // --- Model call + in-process recovery -------------------------------------

  let result: S["callResult"];
  try {
    result = await ports.runModelCall(runner);
  } catch (error) {
    ports.assertNotCancelled();
    const recovery = await ports.recoverModelCall({ error, runner });
    ports.assertNotCancelled();
    if (recovery.outcome === "failed") {
      return await settleCallFailure(ports, { error: recovery.error, runner });
    }
    result = recovery.result;
  }

  // --- After call ------------------------------------------------------------

  const state = await ports.accountUsage({ result, runner });
  return await ports.settleStep({ result, runner, state });
}

/**
 * The failure decision tree for an unrecovered model call:
 *
 * - no event stream → raw rethrow (internal callers handle it);
 * - stream-write failure → park, regardless of mode;
 * - terminal → complete as failure (the task's error result in task mode);
 * - task mode → rethrow when the durable step may retry, else fail the run
 *   (a task cannot park for user-driven recovery);
 * - conversation → park for a user retry.
 */
async function settleCallFailure<S extends StepFlowTypes>(
  ports: StepPorts<S>,
  input: { readonly error: unknown; readonly runner: S["callRunner"] },
): Promise<S["outcome"]> {
  const { error, runner } = input;
  ports.recordCallFailure(error);

  if (!ports.emissionEnabled) {
    throw error;
  }

  const failure = ports.classifyCallFailure(error);

  if (failure.kind === "stream-write") {
    return await ports.parkAfterCallFailure({ error, failure, runner });
  }

  if (failure.kind === "terminal") {
    return await ports.failStep({ asTaskError: ports.mode === "task", error, failure, runner });
  }

  if (ports.mode === "task") {
    if (failure.retriableInTask) {
      ports.onTaskRetryRethrow({ error, runner });
      throw error;
    }
    return await ports.failStep({ asTaskError: true, error, failure, runner });
  }

  return await ports.parkAfterCallFailure({ error, failure, runner });
}
