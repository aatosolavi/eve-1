import { context as otelContext, type Span, trace } from "#compiled/@opentelemetry/api/index.js";
import { createErrorId, createLogger, recordErrorOnSpan } from "#internal/logging.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { toErrorMessage } from "#shared/errors.js";
import {
  accumulateTurnUsage,
  extractGatewayCostUsd,
  extractTokenUsageDelta,
  getTurnUsageState,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import { enforceSessionTokenLimit } from "#harness/session-limit-enforcement.js";
import {
  emitFailedStep,
  emitRecoverableFailedTurn,
  emitStepStarted,
  setHarnessEmissionState,
} from "#harness/emission.js";
import { hasStepInput } from "#harness/input-requests.js";
import { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import {
  classifyModelCallError,
  EmptyModelResponseError,
  extractModelCallErrorDetails,
  extractUpstreamRejectionMessage,
} from "#harness/model-call-error.js";
import { summarizeKnownError } from "#harness/semantic-errors/index.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { extractWorkflowStreamWriteErrorDetails } from "#harness/workflow-stream-error.js";
import {
  enrichTelemetry,
  ensureOtelIntegration,
  resolveStepOtelContext,
  setTurnTraceState,
} from "#harness/otel-integration.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import { classifyParkedSession, handleStepResult } from "#harness/step-result.js";
import {
  attemptEmptyResponseRecovery,
  attemptUnsupportedProviderToolRecovery,
  buildModelCallFailureDetails,
  buildModelCallFailureLogFields,
  runModelCallRecoveryPipeline,
} from "#harness/model-call-recovery.js";
import { assemblePrompt, resolveTurnInput } from "#core/turn-before-call.js";
import { createModelCallRunner, environment, eveVersion } from "#harness/model-call.js";
import { createBeforeCallPorts } from "#harness/turn-before-call.js";
import { continuePendingWorkflowInterrupt } from "#harness/workflow-interrupt-continuation.js";
import type { GenerateOutcome, GenerateFn, StepInput, GenerateConfig } from "#harness/types.js";

/**
 * Creates a generate harness step function backed by AI SDK `ToolLoopAgent`.
 */

const log = createLogger("harness.generate");

export function createGenerate(config: GenerateConfig): GenerateFn {
  const emit = config.handleEvent;
  const telemetryConfig = getInstrumentationConfig();
  if (telemetryConfig !== undefined) {
    ensureOtelIntegration();
  }
  const tracer = telemetryConfig !== undefined ? trace.getTracer("eve") : undefined;
  const agentName = config.runtimeIdentity?.agentName;

  async function runStep(
    initialSession: Readonly<Parameters<GenerateFn>[0]>,
    input?: StepInput,
  ): Promise<GenerateOutcome> {
    // --- Turn span lifecycle ------------------------------------------------

    // First step of a turn: open a new parent span. Continuation steps
    // restore the parent from session state via resolveStepOtelContext.
    let turnSpan: Span | undefined;
    if (tracer && hasStepInput(input)) {
      const functionId = telemetryConfig?.functionId ?? agentName;
      const attributes: Record<string, string> = {
        "eve.version": eveVersion,
        "eve.environment": environment,
        "eve.session.id": initialSession.sessionId,
      };
      if (functionId) {
        attributes["ai.telemetry.functionId"] = functionId;
      }
      turnSpan = tracer.startSpan("ai.eve.turn", { attributes });
    }

    // Run the step body inside the turn span's (or restored parent's)
    // OTel context so AI SDK spans nest as children.
    const parentContext = resolveStepOtelContext(tracer, turnSpan, initialSession);
    const executeStep = () => executeStepBody(initialSession, input, turnSpan);

    try {
      if (parentContext) {
        return await otelContext.with(parentContext, executeStep);
      }
      return await executeStep();
    } finally {
      turnSpan?.end();
    }
  }

  async function executeStepBody(
    initialSession: Readonly<Parameters<GenerateFn>[0]>,
    input?: StepInput,
    turnSpan?: Span,
  ): Promise<GenerateOutcome> {
    let session = initialSession;

    // Store the turn span context on the session so continuation steps
    // can restore the parent trace across step boundaries.
    if (turnSpan) {
      session = setTurnTraceState(session, turnSpan.spanContext());
    }

    const ports = createBeforeCallPorts({
      config,
      telemetry: enrichTelemetry(telemetryConfig, agentName) ?? undefined,
      turnSpan,
    });

    // --- Pre-call stage 1: turn-input resolution (may settle) ---------------

    const resolution = await resolveTurnInput(ports, { input, state: session });
    if (resolution.kind === "settled") {
      return resolution.outcome;
    }
    const effectiveStepInput = resolution.effectiveInput;
    let emissionState = resolution.emissionState;

    // --- Pre-call stage 2: prompt assembly (straight-line) ------------------

    const prepared = await assemblePrompt(ports, resolution);
    session = prepared.session;
    const {
      approvedTools,
      attributionHeaders,
      cachePath,
      ctx,
      emptyDeliveryEnabled,
      marker,
      messages,
      model,
      modelMessages,
      systemMessages,
    } = prepared;

    // --- Model call -----------------------------------------------------------

    /*
     * The `onError` override suppresses the AI SDK's default
     * `console.error(error)` handler inside `streamText`. Errors are
     * handled by the harness catch block and emitted as stream events.
     */

    const modelCall = createModelCallRunner({
      agentName,
      approvedTools,
      attributionHeaders,
      cachePath,
      config,
      ctx,
      emissionState,
      emit,
      marker,
      model,
      modelMessages,
      session,
      systemMessages,
      telemetryConfig,
    });

    // Resolve first-attempt instrumentation before step.started dispatch
    // allows dynamic tool resolvers to update the effective toolset.
    const initialModelCallInput = modelCall.prepareModelCallInput();

    // Emit step.started before building the toolset so dynamic tool
    // resolvers subscribed to step.started write to LiveStepToolsKey.
    if (emit) {
      await emitStepStarted(emit, emissionState, messages);
    }

    // Workflow continuations replay the sandbox after step.started so nested
    // action lifecycle events keep the active turn's emission coordinates.
    const pendingWorkflowInterrupt = await continuePendingWorkflowInterrupt({
      childResults: effectiveStepInput?.runtimeActionResults,
      config,
      emit,
      emissionState,
      session,
    });
    if (pendingWorkflowInterrupt !== null) {
      return pendingWorkflowInterrupt;
    }

    const limitResult = await enforceSessionTokenLimit({
      config,
      emit,
      emissionState,
      messages,
      session,
    });
    if (limitResult !== null) {
      return limitResult;
    }

    let result: HarnessStepResult;
    try {
      result = await modelCall.runOneModelCall({
        preparedInput: initialModelCallInput,
        suppressStepStartedEmission: true,
      });
    } catch (error) {
      throwIfTurnAborted(config.abortSignal);

      // Stage order: drop a gateway-rejected provider tool first, then
      // reissue an empty response; see runModelCallRecoveryPipeline for
      // the skip/act semantics.
      const recoveryResult = await runModelCallRecoveryPipeline({
        error,
        stages: [
          (current) =>
            attemptUnsupportedProviderToolRecovery({
              error: current.error,
              runOneModelCall: modelCall.runOneModelCall,
              sessionId: session.sessionId,
              turnId: emissionState.turnId,
            }),
          (current) =>
            attemptEmptyResponseRecovery({
              emptyDeliveryEnabled,
              error: current.error,
              retryCallOptions: current.retryCallOptions,
              runOneModelCall: modelCall.runOneModelCall,
              sessionId: session.sessionId,
              turnId: emissionState.turnId,
            }),
        ],
      });
      throwIfTurnAborted(config.abortSignal);
      session = modelCall.currentSession();

      if (recoveryResult.outcome === "recovered") {
        result = recoveryResult.result;
      } else {
        // Surface the full cause chain + upstream responseBody to OTel
        // via the turn span. The AI SDK's automatic
        // `span.recordException(err)` on its own `ai.streamText` span
        // only captures `error.stack` and does not traverse `cause`,
        // so the gateway-wrapped upstream 4xx body would otherwise be
        // invisible to OTel providers.
        const finalError = recoveryResult.error;
        if (turnSpan) {
          recordErrorOnSpan(turnSpan, finalError);
        }

        if (!emit) {
          // Internal harness callers without an emit fn (tests, task-only
          // code paths) get the raw throw. Only runtime-connected harness
          // calls go through the structured failure path below.
          throw finalError;
        }

        // A durable event-stream write failure reaches this catch only
        // because `emitStreamContent` runs inside the model-call
        // try/catch — the model call itself may have succeeded. Label it
        // as the workflow-infrastructure failure it is instead of
        // misattributing it to the model provider, and surface the
        // failing endpoint + platform error code as evidence.
        const streamWriteDetails = extractWorkflowStreamWriteErrorDetails(finalError);
        if (streamWriteDetails !== null) {
          const errorId = createErrorId();
          log.error("workflow stream write failed — parking session for retry by the user", {
            ...streamWriteDetails,
            errorId,
            error: finalError,
            sessionId: session.sessionId,
            turnId: emissionState.turnId,
          });
          emissionState = await emitRecoverableFailedTurn(emit, emissionState, {
            code: "WORKFLOW_STREAM_WRITE_FAILED",
            continuationToken: session.continuationToken,
            details: { ...streamWriteDetails, errorId },
            message: toErrorMessage(finalError),
          });
          const parkedSession = setHarnessEmissionState(session, emissionState);
          return classifyParkedSession(parkedSession);
        }

        const classification = classifyModelCallError(finalError);
        const errorId = createErrorId();
        const catalogSummary = summarizeKnownError(finalError);
        const upstreamRejection =
          catalogSummary === null ? extractUpstreamRejectionMessage(finalError) : null;
        const errorMessage =
          catalogSummary?.message ?? upstreamRejection?.message ?? toErrorMessage(finalError);
        // Task failures surface as the parent agent's tool-result text, so
        // the remediation rides along in prose — the parent can act on it
        // or relay it. Event payloads keep hint structured in details.
        const taskFailureOutput =
          catalogSummary?.hint === undefined
            ? errorMessage
            : `${errorMessage} ${catalogSummary.hint}`;
        const modelCallDetails = extractModelCallErrorDetails(finalError);
        const details = buildModelCallFailureDetails({
          catalogSummary,
          error: finalError,
          errorId,
          modelCallDetails,
          upstreamRejection,
        });
        const modelCallLogFields = buildModelCallFailureLogFields({
          error: finalError,
          errorId,
          modelCallDetails,
          recognized: catalogSummary !== null || upstreamRejection !== null,
          sessionId: session.sessionId,
          turnId: emissionState.turnId,
        });

        if (classification === "terminal") {
          if (catalogSummary !== null) {
            // Recognized configuration failure: log a concise single line
            // and skip the structured SDK dump so the user sees an
            // actionable hint instead of a wall of inspector output.
            log.error(`${catalogSummary.name}: ${catalogSummary.message}`, {
              errorId,
              hint: catalogSummary.hint,
              sessionId: session.sessionId,
              turnId: emissionState.turnId,
            });
          } else {
            log.error(
              upstreamRejection?.message ?? "model call failed terminally",
              modelCallLogFields,
            );
          }
          await emitFailedStep(emit, emissionState, {
            code: "MODEL_CALL_FAILED",
            details,
            message: errorMessage,
            sessionId: session.sessionId,
          });
          // In task mode (delegated subagent runs) the terminal failure
          // must be the task's error result so the parent driver resumes
          // with a failed `subagent-result` instead of a successful empty
          // output (https://github.com/vercel/eve/issues/412).
          return config.mode === "task"
            ? { action: "done", isError: true, output: taskFailureOutput, state: session }
            : { action: "done", output: "", state: session };
        }

        if (config.mode === "task") {
          if (
            classification === "recoverable" &&
            !(finalError instanceof EmptyModelResponseError)
          ) {
            // Task runs cannot park for user-driven recovery. Let the durable
            // step retry from committed session state, but only for errors
            // that did not already consume the in-process transient budget or
            // the dedicated empty-response reissue.
            log.warn(
              upstreamRejection?.message ??
                "model call failed recoverably in task mode — rethrowing for durable step retry",
              modelCallLogFields,
            );
            throw finalError;
          }

          // A task run cannot park for a user retry (turnWorkflow rejects
          // a waiting park in task mode). Classified transient errors arrive
          // here only after their bounded in-process retries are exhausted;
          // empty responses already received their specialized reissue.
          log.error(
            upstreamRejection?.message ?? "model call failed; failing the task run",
            modelCallLogFields,
          );
          await emitFailedStep(emit, emissionState, {
            code: "MODEL_CALL_FAILED",
            details,
            message: errorMessage,
            sessionId: session.sessionId,
          });
          return { action: "done", isError: true, output: taskFailureOutput, state: session };
        }

        log.error(
          upstreamRejection?.message ?? "model call failed — parking session for retry by the user",
          modelCallLogFields,
        );
        emissionState = await emitRecoverableFailedTurn(emit, emissionState, {
          code: "MODEL_CALL_FAILED",
          continuationToken: session.continuationToken,
          details,
          message: errorMessage,
        });
        const parkedSession = setHarnessEmissionState(session, emissionState);
        return classifyParkedSession(parkedSession);
      }
    }
    session = modelCall.currentSession();

    // --- Step-side observability tags ---------------------------------------
    //
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
    const nextTurnUsage = accumulateTurnUsage({
      previous: getTurnUsageState(session.state),
      turnId: emissionState.turnId,
      usage: extractTokenUsageDelta({
        costUsd: extractGatewayCostUsd(result.providerMetadata),
        usage: result.usage,
      }),
    });
    session = setTurnUsageState(session, nextTurnUsage);
    // `formatLanguageModelGatewayId` requires `model.provider` to be a string;
    // mock models in tests omit it, so guard the lookup so a missing field
    // becomes `undefined` and is dropped by the attribute writer instead of
    // throwing into the tool loop.
    let modelTag: string | undefined;
    try {
      modelTag = formatLanguageModelGatewayId(model);
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

    // --- Handle result ------------------------------------------------------

    return handleStepResult({
      config,
      emit,
      emissionState,
      promptMessages: messages,
      result,
      session,
    });
  }

  return runStep;
}
