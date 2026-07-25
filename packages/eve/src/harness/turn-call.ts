import type {
  CallDependencies,
  FailureDependencies,
  FlowLog,
  RecoveryStage,
  SettleDependencies,
  UsageDependencies,
} from "#core/step-ports.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import type { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import {
  classifyModelCallError,
  EmptyModelResponseError,
  extractModelCallErrorDetails,
  extractUpstreamRejectionMessage,
} from "#core/model-call-error.js";
import {
  attemptEmptyResponseRecovery,
  attemptUnsupportedProviderToolRecovery,
  buildModelCallFailureDetails,
  buildModelCallFailureLogFields,
} from "#harness/model-call-recovery.js";
import { createModelCallRunner } from "#harness/model-call.js";
import { enforceSessionTokenLimit } from "#core/session-limit-enforcement.js";
import { summarizeKnownError } from "#core/semantic-errors/index.js";
import type { HarnessStepFlow } from "#harness/step-flow.js";
import { classifyParkedSession } from "#core/step-outcome.js";
import { handleStepResult } from "#harness/step-result.js";
import {
  accumulateTurnUsage,
  extractGatewayCostUsd,
  extractTokenUsageDelta,
  getTurnUsageState,
  setTurnUsageState,
} from "#core/turn-tag-state.js";
import { throwIfTurnAborted } from "#core/turn-cancellation.js";
import { setHarnessEmissionState } from "#core/emission.js";
import type { GenerateConfig } from "#harness/types.js";
import { extractWorkflowStreamWriteErrorDetails } from "#core/workflow-stream-error.js";
import { continuePendingWorkflowInterrupt } from "#harness/workflow-interrupt-continuation.js";
import { toErrorMessage } from "#core/shared/errors.js";

const log = createLogger("harness.generate");

/**
 * The call-phase dependencies of the core step flow: the AI SDK
 * model-call runner, the recovery stages, failure predicates and content,
 * usage accounting, and outcome classification. Preflight order, the
 * recovery loop, and the failure decision tree live in
 * `core/turn-call.ts`.
 */

/** Binds the model-call primitives. */
export function createCallDependencies(input: {
  readonly agentName: string | undefined;
  readonly config: GenerateConfig;
  readonly telemetryConfig: ReturnType<typeof getInstrumentationConfig>;
}): CallDependencies<HarnessStepFlow> {
  const { agentName, config, telemetryConfig } = input;
  const emit = config.handleEvent;

  return {
    assertNotCancelled() {
      throwIfTurnAborted(config.abortSignal);
    },

    async continueWorkflowInterrupt({ emissionState, input: stepInput, prompt }) {
      return await continuePendingWorkflowInterrupt({
        childResults: stepInput?.runtimeActionResults,
        config,
        emit,
        emissionState,
        session: prompt.session,
      });
    },

    create({ emissionState, prompt }) {
      return {
        emissionState,
        modelCall: createModelCallRunner({
          agentName,
          approvedTools: prompt.approvedTools,
          attributionHeaders: prompt.attributionHeaders,
          cachePath: prompt.cachePath,
          config,
          ctx: prompt.ctx,
          emissionState,
          emit,
          marker: prompt.marker,
          model: prompt.model,
          modelMessages: prompt.modelMessages,
          session: prompt.session,
          systemMessages: prompt.systemMessages,
          telemetryConfig,
        }),
        prompt,
      };
    },

    currentState: (runner) => runner.modelCall.currentSession(),

    async enforceTokenLimit({ emissionState, prompt }) {
      return await enforceSessionTokenLimit({
        config,
        emit,
        emissionState,
        messages: prompt.messages,
        session: prompt.session,
      });
    },

    prepareAttempt: (runner) => runner.modelCall.prepareModelCallInput(),

    // Stage order matters and is owned by the core recovery loop: drop a
    // gateway-rejected provider tool first, then reissue an empty response.
    recoveryStages: [
      async ({ error, runner }) =>
        asStageResult(
          await attemptUnsupportedProviderToolRecovery({
            error,
            runOneModelCall: runner.modelCall.runOneModelCall,
            sessionId: runner.prompt.session.sessionId,
            turnId: runner.emissionState.turnId,
          }),
        ),
      async ({ error, retryOptions, runner }) =>
        asStageResult(
          await attemptEmptyResponseRecovery({
            emptyDeliveryEnabled: runner.prompt.emptyDeliveryEnabled,
            error,
            retryCallOptions: retryOptions,
            runOneModelCall: runner.modelCall.runOneModelCall,
            sessionId: runner.prompt.session.sessionId,
            turnId: runner.emissionState.turnId,
          }),
        ),
    ],

    run({ attempt, runner }) {
      return runner.modelCall.runOneModelCall({
        preparedInput: attempt,
        suppressStepStartedEmission: true,
      });
    },
  };
}

/** Maps one harness recovery-attempt outcome onto the core stage result. */
function asStageResult(
  outcome:
    | Awaited<ReturnType<typeof attemptUnsupportedProviderToolRecovery>>
    | Awaited<ReturnType<typeof attemptEmptyResponseRecovery>>,
): Awaited<ReturnType<RecoveryStage<HarnessStepFlow>>> {
  if (outcome.outcome === "failed") {
    return { error: outcome.error, outcome: "failed", retryOptions: outcome.retryCallOptions };
  }
  return outcome;
}

/** Binds the failure predicates and failure-content derivation. */
export function createFailureDependencies(): FailureDependencies<HarnessStepFlow> {
  return {
    classification: (error) => classifyModelCallError(error),

    describe({ error, runner }) {
      const session = runner.modelCall.currentSession();
      const errorId = createErrorId();
      const catalogSummary = summarizeKnownError(error);
      const upstreamRejection =
        catalogSummary === null ? extractUpstreamRejectionMessage(error) : null;
      const errorMessage =
        catalogSummary?.message ?? upstreamRejection?.message ?? toErrorMessage(error);
      const modelCallDetails = extractModelCallErrorDetails(error);
      return {
        content: {
          code: "MODEL_CALL_FAILED",
          details: buildModelCallFailureDetails({
            catalogSummary,
            error,
            errorId,
            modelCallDetails,
            upstreamRejection,
          }),
          message: errorMessage,
        },
        logFields: buildModelCallFailureLogFields({
          error,
          errorId,
          modelCallDetails,
          recognized: catalogSummary !== null || upstreamRejection !== null,
          sessionId: session.sessionId,
          turnId: runner.emissionState.turnId,
        }),
        // Recognized configuration failure: one concise actionable line
        // instead of the structured SDK dump.
        recognizedTerminal:
          catalogSummary === null
            ? undefined
            : {
                fields: {
                  errorId,
                  hint: catalogSummary.hint,
                  sessionId: session.sessionId,
                  turnId: runner.emissionState.turnId,
                },
                message: `${catalogSummary.name}: ${catalogSummary.message}`,
              },
        // Task failures surface as the parent agent's tool-result text, so
        // the remediation hint rides along in prose.
        taskOutput:
          catalogSummary?.hint === undefined
            ? errorMessage
            : `${errorMessage} ${catalogSummary.hint}`,
        upstreamMessage: upstreamRejection?.message,
      };
    },

    describeStreamWrite({ error, runner }) {
      const session = runner.modelCall.currentSession();
      const details = extractWorkflowStreamWriteErrorDetails(error);
      const errorId = createErrorId();
      return {
        content: {
          code: "WORKFLOW_STREAM_WRITE_FAILED",
          details: { ...details, errorId },
          message: toErrorMessage(error),
        },
        logFields: {
          ...details,
          errorId,
          error,
          sessionId: session.sessionId,
          turnId: runner.emissionState.turnId,
        },
      };
    },

    isRetryBudgetConsumed: (error) => error instanceof EmptyModelResponseError,

    isStreamWriteFailure: (error) => extractWorkflowStreamWriteErrorDetails(error) !== null,
  };
}

/** Binds usage accounting to the per-turn tag state and attribute store. */
export function createUsageDependencies(
  config: GenerateConfig,
): UsageDependencies<HarnessStepFlow> {
  return {
    // Per-turn totals accumulate on the state because each tool-loop
    // iteration is a fresh durable step and the attribute store's
    // last-write-wins per-key semantics mean only the running total —
    // not the per-step delta — should reach the dashboard.
    accumulate({ result, runner }) {
      const session = runner.modelCall.currentSession();
      const snapshot = accumulateTurnUsage({
        previous: getTurnUsageState(session.state),
        turnId: runner.emissionState.turnId,
        usage: extractTokenUsageDelta({
          costUsd: extractGatewayCostUsd(result.providerMetadata),
          usage: result.usage,
        }),
      });
      return { snapshot, state: setTurnUsageState(session, snapshot) };
    },

    // Best-effort: the runtime-injected writer swallows failures so a
    // broken tag emit can never break the agent loop.
    async publish({ runner, snapshot }) {
      // `formatLanguageModelGatewayId` requires `model.provider` to be a
      // string; mock models in tests omit it, so a missing field becomes
      // `undefined` and is dropped by the attribute writer instead of
      // throwing into the tool loop.
      let modelTag: string | undefined;
      try {
        modelTag = formatLanguageModelGatewayId(runner.prompt.model);
      } catch {
        modelTag = undefined;
      }
      await config.writeEveAttributes?.({
        "$eve.model": modelTag,
        "$eve.input_tokens": snapshot.inputTokens,
        "$eve.output_tokens": snapshot.outputTokens,
        "$eve.cache_read_tokens": snapshot.cacheReadTokens,
        "$eve.cache_write_tokens": snapshot.cacheWriteTokens,
        "$eve.cost_usd": snapshot.sawCost ? snapshot.costUsd : undefined,
        "$eve.tool_count": config.tools.size,
      });
    },
  };
}

/** Binds outcome classification. */
export function createSettleDependencies(
  config: GenerateConfig,
): SettleDependencies<HarnessStepFlow> {
  return {
    parked: ({ emissionState, state }) =>
      classifyParkedSession(
        emissionState === undefined ? state : setHarnessEmissionState(state, emissionState),
      ),

    step: ({ emissionState, prompt, result, state }) =>
      handleStepResult({
        config,
        emit: config.handleEvent,
        emissionState,
        promptMessages: prompt.messages,
        result,
        session: state,
      }),
  };
}

/** Binds flow logging to the harness logger. */
export function createFlowLog(): FlowLog<HarnessStepFlow> {
  return {
    error: (message, fields) => log.error(message, fields),
    warn: (message, fields) => log.warn(message, fields),
  };
}
