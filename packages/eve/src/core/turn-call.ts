import type { Span } from "#compiled/@opentelemetry/api/index.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";

import {
  emitFailedStep,
  emitRecoverableFailedTurn,
  emitStepStarted,
  setHarnessEmissionState,
  type HarnessEmissionState,
} from "#core/emission.js";
import { classifyModelCallError, EmptyModelResponseError } from "#core/model-call-error.js";
import { hasStepInput } from "#core/input-requests.js";
import { enforceSessionTokenLimit } from "#core/session-limit-enforcement.js";
import type { RecoveryStage, StepCallRunner, StepServices } from "#core/step-services.js";
import { classifyParkedSession } from "#core/step-outcome.js";
import {
  accumulateTurnUsage,
  extractGatewayCostUsd,
  extractTokenUsageDelta,
  getTurnUsageState,
  setTurnUsageState,
} from "#core/turn-tag-state.js";
import { throwIfTurnAborted } from "#core/turn-cancellation.js";
import { extractWorkflowStreamWriteErrorDetails } from "#core/workflow-stream-error.js";
import { assemblePrompt, resolveTurnInput } from "#core/turn-before-call.js";
import type { GenerateConfig, GenerateOutcome, HarnessSession, StepInput } from "#harness/types.js";

/** Runs one concrete generate step inside its turn trace. */
export async function generateStep(input: {
  readonly config: GenerateConfig;
  readonly input: StepInput | undefined;
  readonly services: StepServices;
  readonly state: HarnessSession;
}): Promise<GenerateOutcome> {
  const { services } = input;
  const turnTrace = hasStepInput(input.input)
    ? services.trace.start("ai.eve.turn", turnAttributes(services, input.state))
    : undefined;
  try {
    const state =
      turnTrace === undefined
        ? input.state
        : services.trace.bind({ state: input.state, trace: turnTrace });
    return await services.trace.inContext({ state, trace: turnTrace }, () =>
      runStepFlow({ ...input, state, trace: turnTrace }),
    );
  } finally {
    if (turnTrace !== undefined) {
      services.trace.end(turnTrace);
    }
  }
}

function turnAttributes(services: StepServices, state: HarnessSession): Record<string, string> {
  const attributes: Record<string, string> = {
    "eve.environment": services.trace.identity.environment,
    "eve.session.id": state.sessionId,
    "eve.version": services.trace.identity.eveVersion,
  };
  const functionId = services.trace.identity.functionId;
  if (functionId !== undefined && functionId !== "") {
    attributes["ai.telemetry.functionId"] = functionId;
  }
  return attributes;
}

async function runStepFlow(input: {
  readonly config: GenerateConfig;
  readonly input: StepInput | undefined;
  readonly services: StepServices;
  readonly state: HarnessSession;
  readonly trace: Span | undefined;
}): Promise<GenerateOutcome> {
  const { config, services } = input;
  const resolution = await resolveTurnInput(input);
  if (resolution.kind === "settled") {
    return resolution.outcome;
  }
  const { emissionState } = resolution;

  const prompt = await assemblePrompt({ config, resolved: resolution, services });
  const modelCall = services.modelCall.create({ emissionState, prompt });
  const runner: StepCallRunner = { emissionState, modelCall, prompt };
  const attempt = services.modelCall.prepareAttempt(modelCall);

  if (config.handleEvent !== undefined) {
    await emitStepStarted(config.handleEvent, emissionState, prompt.messages);
  }

  const interrupted = await services.modelCall.continueWorkflowInterrupt({
    emissionState,
    input: resolution.effectiveInput,
    prompt,
  });
  if (interrupted !== null) {
    return interrupted;
  }

  const limited = await enforceSessionTokenLimit({
    config,
    emit: config.handleEvent,
    emissionState,
    messages: prompt.messages,
    session: prompt.session,
  });
  if (limited !== null) {
    return limited;
  }

  let result;
  try {
    result = await services.modelCall.run({ attempt, runner: modelCall });
  } catch (error) {
    throwIfTurnAborted(config.abortSignal);
    const recovery = await recoverModelCall(services.modelCall.recoveryStages, {
      error,
      runner,
    });
    throwIfTurnAborted(config.abortSignal);
    if (recovery.outcome === "failed") {
      return await settleCallFailure({
        config,
        emissionState,
        error: recovery.error,
        runner,
        services,
        trace: input.trace,
      });
    }
    result = recovery.result;
  }

  const state = services.modelCall.currentState(modelCall);
  const snapshot = accumulateTurnUsage({
    previous: getTurnUsageState(state.state),
    turnId: emissionState.turnId,
    usage: extractTokenUsageDelta({
      costUsd: extractGatewayCostUsd(result.providerMetadata),
      usage: result.usage,
    }),
  });
  const accountedState = setTurnUsageState(state, snapshot);
  await services.usage.publish({ runner, snapshot });
  return await services.settle.step({
    emissionState,
    prompt,
    result,
    state: accountedState,
  });
}

async function recoverModelCall(
  stages: readonly RecoveryStage[],
  input: { readonly error: unknown; readonly runner: StepCallRunner },
): Promise<
  | { readonly outcome: "recovered"; readonly result: HarnessStepResult }
  | { readonly outcome: "failed"; readonly error: unknown }
> {
  let error = input.error;
  let retryOptions;
  for (const stage of stages) {
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

async function settleCallFailure(input: {
  readonly config: GenerateConfig;
  readonly emissionState: HarnessEmissionState;
  readonly error: unknown;
  readonly runner: StepCallRunner;
  readonly services: StepServices;
  readonly trace: Span | undefined;
}): Promise<GenerateOutcome> {
  const { config, emissionState, error, runner, services, trace } = input;
  if (trace !== undefined) {
    services.trace.recordError(trace, error);
  }

  const emit = config.handleEvent;
  if (emit === undefined) {
    throw error;
  }
  const state = services.modelCall.currentState(runner.modelCall);

  if (extractWorkflowStreamWriteErrorDetails(error) !== null) {
    const described = services.failure.describeStreamWrite({ error, runner });
    services.log.error(
      "workflow stream write failed — parking session for retry by the user",
      described.logFields,
    );
    const advanced = await emitRecoverableFailedTurn(emit, emissionState, {
      code: described.content.code,
      continuationToken: state.continuationToken,
      details: described.content.details,
      message: described.content.message,
    });
    return classifyParkedSession(setHarnessEmissionState(state, advanced));
  }

  const described = services.failure.describe({ error, runner });
  const classification = classifyModelCallError(error);

  if (classification === "terminal") {
    if (described.recognizedTerminal !== undefined) {
      services.log.error(described.recognizedTerminal.message, described.recognizedTerminal.fields);
    } else {
      services.log.error(
        described.upstreamMessage ?? "model call failed terminally",
        described.logFields,
      );
    }
    await emitFailedStep(emit, emissionState, {
      code: described.content.code,
      details: described.content.details,
      message: described.content.message,
      sessionId: state.sessionId,
    });
    return config.mode === "task"
      ? { action: "done", isError: true, output: described.taskOutput, state }
      : { action: "done", output: "", state };
  }

  if (config.mode === "task") {
    if (classification === "recoverable" && !(error instanceof EmptyModelResponseError)) {
      services.log.warn(
        described.upstreamMessage ??
          "model call failed recoverably in task mode — rethrowing for durable step retry",
        described.logFields,
      );
      throw error;
    }

    services.log.error(
      described.upstreamMessage ?? "model call failed; failing the task run",
      described.logFields,
    );
    await emitFailedStep(emit, emissionState, {
      code: described.content.code,
      details: described.content.details,
      message: described.content.message,
      sessionId: state.sessionId,
    });
    return { action: "done", isError: true, output: described.taskOutput, state };
  }

  services.log.error(
    described.upstreamMessage ?? "model call failed — parking session for retry by the user",
    described.logFields,
  );
  const advanced = await emitRecoverableFailedTurn(emit, emissionState, {
    code: described.content.code,
    continuationToken: state.continuationToken,
    details: described.content.details,
    message: described.content.message,
  });
  return classifyParkedSession(setHarnessEmissionState(state, advanced));
}
