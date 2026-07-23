import type { CallPorts } from "#core/turn-call.js";
import { createErrorId, createLogger, recordErrorOnSpan } from "#internal/logging.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import {
  emitFailedStep,
  emitRecoverableFailedTurn,
  emitStepStarted,
  setHarnessEmissionState,
  type HarnessEmissionState,
} from "#harness/emission.js";
import type { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import {
  classifyModelCallError,
  EmptyModelResponseError,
  extractModelCallErrorDetails,
  extractUpstreamRejectionMessage,
} from "#harness/model-call-error.js";
import {
  attemptEmptyResponseRecovery,
  attemptUnsupportedProviderToolRecovery,
  buildModelCallFailureDetails,
  buildModelCallFailureLogFields,
  runModelCallRecoveryPipeline,
} from "#harness/model-call-recovery.js";
import { createModelCallRunner } from "#harness/model-call.js";
import { enforceSessionTokenLimit } from "#harness/session-limit-enforcement.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import type { HarnessStepFlow, TurnSpanCell } from "#harness/step-flow.js";
import { classifyParkedSession, handleStepResult } from "#harness/step-result.js";
import {
  accumulateTurnUsage,
  extractGatewayCostUsd,
  extractTokenUsageDelta,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { GenerateConfig, HarnessSession } from "#harness/types.js";
import { extractWorkflowStreamWriteErrorDetails } from "#harness/workflow-stream-error.js";
import { continuePendingWorkflowInterrupt } from "#harness/workflow-interrupt-continuation.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("harness.generate");

/**
 * The call and after-call ports of the core step flow
 * ({@link import("#core/turn-call.js").generateStep}), bound to the
 * harness: the AI SDK model-call runner, the staged recovery pipeline,
 * all failure content (log lines, failure events, error details), usage
 * accounting, and result settlement. The failure *decisions* — park
 * versus fail versus rethrow — live in core.
 */
export function createCallPorts(input: {
  readonly agentName: string | undefined;
  readonly config: GenerateConfig;
  readonly telemetryConfig: ReturnType<typeof getInstrumentationConfig>;
  /** The step's turn-span slot, where unrecovered call failures are recorded. */
  readonly turnSpan: TurnSpanCell;
}): CallPorts<HarnessStepFlow> {
  const { agentName, config, telemetryConfig, turnSpan } = input;
  const emit = config.handleEvent;

  return {
    mode: config.mode,

    prepareModelCall({ emissionState, prompt }) {
      const modelCall = createModelCallRunner({
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
      });
      // Resolve the first attempt's input eagerly: step.started dispatch
      // allows dynamic tool resolvers to update the effective toolset.
      return { emissionState, modelCall, preparedInput: modelCall.prepareModelCallInput(), prompt };
    },

    async emitStepStarted(runner) {
      if (emit === undefined) {
        return;
      }
      await emitStepStarted(emit, runner.emissionState, runner.prompt.messages);
    },

    async continueWorkflowInterrupt({ input: stepInput, runner }) {
      return await continuePendingWorkflowInterrupt({
        childResults: stepInput?.runtimeActionResults,
        config,
        emit,
        emissionState: runner.emissionState,
        session: runner.prompt.session,
      });
    },

    async enforceTokenLimit(runner) {
      return await enforceSessionTokenLimit({
        config,
        emit,
        emissionState: runner.emissionState,
        messages: runner.prompt.messages,
        session: runner.prompt.session,
      });
    },

    async runModelCall(runner) {
      return await runner.modelCall.runOneModelCall({
        preparedInput: runner.preparedInput,
        suppressStepStartedEmission: true,
      });
    },

    assertNotCancelled() {
      throwIfTurnAborted(config.abortSignal);
    },

    // Stage order: drop a gateway-rejected provider tool first, then
    // reissue an empty response; see runModelCallRecoveryPipeline for
    // the skip/act semantics.
    async recoverModelCall({ error, runner }) {
      const recovery = await runModelCallRecoveryPipeline({
        error,
        stages: [
          (current) =>
            attemptUnsupportedProviderToolRecovery({
              error: current.error,
              runOneModelCall: runner.modelCall.runOneModelCall,
              sessionId: runner.prompt.session.sessionId,
              turnId: runner.emissionState.turnId,
            }),
          (current) =>
            attemptEmptyResponseRecovery({
              emptyDeliveryEnabled: runner.prompt.emptyDeliveryEnabled,
              error: current.error,
              retryCallOptions: current.retryCallOptions,
              runOneModelCall: runner.modelCall.runOneModelCall,
              sessionId: runner.prompt.session.sessionId,
              turnId: runner.emissionState.turnId,
            }),
        ],
      });
      if (recovery.outcome === "recovered") {
        return { outcome: "recovered", result: recovery.result };
      }
      return { error: recovery.error, outcome: "failed" };
    },

    // Surface the full cause chain + upstream responseBody to OTel via the
    // turn span. The AI SDK's automatic `span.recordException(err)` on its
    // own `ai.streamText` span only captures `error.stack` and does not
    // traverse `cause`, so the gateway-wrapped upstream 4xx body would
    // otherwise be invisible to OTel providers.
    recordCallFailure(error) {
      if (turnSpan.current) {
        recordErrorOnSpan(turnSpan.current, error);
      }
    },

    classifyCallFailure(error) {
      // A durable event-stream write failure reaches the call's catch only
      // because `emitStreamContent` runs inside the model-call try/catch —
      // the model call itself may have succeeded. Label it as the
      // workflow-infrastructure failure it is instead of misattributing it
      // to the model provider.
      if (extractWorkflowStreamWriteErrorDetails(error) !== null) {
        return { kind: "stream-write" };
      }
      const classification = classifyModelCallError(error);
      if (classification === "terminal") {
        return { kind: "terminal" };
      }
      // Only errors that did not already consume the in-process transient
      // budget or the dedicated empty-response reissue may be rethrown for
      // a durable-step retry in task mode.
      return {
        kind: "recoverable",
        retriableInTask:
          classification === "recoverable" && !(error instanceof EmptyModelResponseError),
      };
    },

    async parkAfterCallFailure({ error, failure, runner }) {
      const emitFn = requireEmit(emit, error);
      const session = runner.modelCall.currentSession();
      const { emissionState } = runner;

      if (failure.kind === "stream-write") {
        const streamWriteDetails = extractWorkflowStreamWriteErrorDetails(error);
        const errorId = createErrorId();
        log.error("workflow stream write failed — parking session for retry by the user", {
          ...streamWriteDetails,
          errorId,
          error,
          sessionId: session.sessionId,
          turnId: emissionState.turnId,
        });
        return classifyParkedSession(
          setHarnessEmissionState(
            session,
            await emitRecoverableFailedTurn(emitFn, emissionState, {
              code: "WORKFLOW_STREAM_WRITE_FAILED",
              continuationToken: session.continuationToken,
              details: { ...streamWriteDetails, errorId },
              message: toErrorMessage(error),
            }),
          ),
        );
      }

      const described = describeModelCallFailure(error, session, emissionState);
      log.error(
        described.upstreamRejection?.message ??
          "model call failed — parking session for retry by the user",
        described.logFields,
      );
      return classifyParkedSession(
        setHarnessEmissionState(
          session,
          await emitRecoverableFailedTurn(emitFn, emissionState, {
            code: "MODEL_CALL_FAILED",
            continuationToken: session.continuationToken,
            details: described.details,
            message: described.errorMessage,
          }),
        ),
      );
    },

    async failStep({ asTaskError, error, failure, runner }) {
      const emitFn = requireEmit(emit, error);
      const session = runner.modelCall.currentSession();
      const { emissionState } = runner;
      const described = describeModelCallFailure(error, session, emissionState);

      if (failure.kind === "terminal" && described.catalogSummary !== null) {
        // Recognized configuration failure: log a concise single line and
        // skip the structured SDK dump so the user sees an actionable hint
        // instead of a wall of inspector output.
        log.error(`${described.catalogSummary.name}: ${described.catalogSummary.message}`, {
          errorId: described.errorId,
          hint: described.catalogSummary.hint,
          sessionId: session.sessionId,
          turnId: emissionState.turnId,
        });
      } else {
        log.error(
          described.upstreamRejection?.message ??
            (failure.kind === "terminal"
              ? "model call failed terminally"
              : "model call failed; failing the task run"),
          described.logFields,
        );
      }

      await emitFailedStep(emitFn, emissionState, {
        code: "MODEL_CALL_FAILED",
        details: described.details,
        message: described.errorMessage,
        sessionId: session.sessionId,
      });

      // In task mode (delegated subagent runs) the failure must be the
      // task's error result so the parent driver resumes with a failed
      // `subagent-result` instead of a successful empty output
      // (https://github.com/vercel/eve/issues/412).
      return asTaskError
        ? { action: "done", isError: true, output: described.taskFailureOutput, state: session }
        : { action: "done", output: "", state: session };
    },

    onTaskRetryRethrow({ error, runner }) {
      const session = runner.modelCall.currentSession();
      const described = describeModelCallFailure(error, session, runner.emissionState);
      log.warn(
        described.upstreamRejection?.message ??
          "model call failed recoverably in task mode — rethrowing for durable step retry",
        described.logFields,
      );
    },

    // Tag the **turn workflow run** (the current `"use step"` is hosted by
    // that workflow, so `experimental_setAttributes` writes to its
    // attributes table) with the model id and per-turn cumulative token
    // counts. Per-turn totals are accumulated on `session.state` because
    // each tool-loop iteration is a fresh `"use step"` and the workflow
    // runtime's last-write-wins per-key semantics mean only the running
    // total — not the per-step delta — should reach the dashboard.
    //
    // Best-effort: the runtime-injected writer swallows runtime failures
    // so a broken tag emit can never break the agent loop.
    async accountUsage({ result, runner }) {
      const session = runner.modelCall.currentSession();
      const nextTurnUsage = accumulateTurnUsage({
        previous: getTurnUsageState(session.state),
        turnId: runner.emissionState.turnId,
        usage: extractTokenUsageDelta({
          costUsd: extractGatewayCostUsd(result.providerMetadata),
          usage: result.usage,
        }),
      });
      // `formatLanguageModelGatewayId` requires `model.provider` to be a
      // string; mock models in tests omit it, so guard the lookup so a
      // missing field becomes `undefined` and is dropped by the attribute
      // writer instead of throwing into the tool loop.
      let modelTag: string | undefined;
      try {
        modelTag = formatLanguageModelGatewayId(runner.prompt.model);
      } catch {
        modelTag = undefined;
      }
      await config.writeEveAttributes?.({
        "$eve.model": modelTag,
        "$eve.input_tokens": nextTurnUsage.inputTokens,
        "$eve.output_tokens": nextTurnUsage.outputTokens,
        "$eve.cache_read_tokens": nextTurnUsage.cacheReadTokens,
        "$eve.cache_write_tokens": nextTurnUsage.cacheWriteTokens,
        "$eve.cost_usd": nextTurnUsage.sawCost ? nextTurnUsage.costUsd : undefined,
        "$eve.tool_count": config.tools.size,
      });
      return setTurnUsageState(session, nextTurnUsage);
    },

    async settleStep({ result, runner, state }) {
      return await handleStepResult({
        config,
        emit,
        emissionState: runner.emissionState,
        promptMessages: runner.prompt.messages,
        result,
        session: state,
      });
    },
  };
}

/**
 * Narrows the optional emit fn for the failure ports. Core only routes a
 * failure here when emission is enabled, so a missing emit fn is a wiring
 * bug — rethrow the original error rather than masking it.
 */
function requireEmit(
  emit: GenerateConfig["handleEvent"],
  error: unknown,
): NonNullable<GenerateConfig["handleEvent"]> {
  if (emit === undefined) {
    throw error;
  }
  return emit;
}

/**
 * Derives every piece of failure content the log lines and failure events
 * share for one unrecovered model-call error.
 */
function describeModelCallFailure(
  error: unknown,
  session: HarnessSession,
  emissionState: HarnessEmissionState,
) {
  const errorId = createErrorId();
  const catalogSummary = summarizeKnownError(error);
  const upstreamRejection = catalogSummary === null ? extractUpstreamRejectionMessage(error) : null;
  const errorMessage =
    catalogSummary?.message ?? upstreamRejection?.message ?? toErrorMessage(error);
  const modelCallDetails = extractModelCallErrorDetails(error);
  return {
    catalogSummary,
    details: buildModelCallFailureDetails({
      catalogSummary,
      error,
      errorId,
      modelCallDetails,
      upstreamRejection,
    }),
    errorId,
    errorMessage,
    logFields: buildModelCallFailureLogFields({
      error,
      errorId,
      modelCallDetails,
      recognized: catalogSummary !== null || upstreamRejection !== null,
      sessionId: session.sessionId,
      turnId: emissionState.turnId,
    }),
    // Task failures surface as the parent agent's tool-result text, so the
    // remediation rides along in prose — the parent can act on it or relay
    // it. Event payloads keep hint structured in details.
    taskFailureOutput:
      catalogSummary?.hint === undefined ? errorMessage : `${errorMessage} ${catalogSummary.hint}`,
    upstreamRejection,
  };
}
