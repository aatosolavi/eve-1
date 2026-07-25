import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";
import { generateText } from "ai";

import { isScheduleAppAuth } from "#channel/schedule-auth.js";
import { contextStorage } from "#context/container.js";
import { buildDynamicInstructionMessages } from "#context/dynamic-instruction-lifecycle.js";
import { PendingSkillAnnouncementKey } from "#context/dynamic-skill-lifecycle.js";
import { AuthKey, ParentSessionKey } from "#core/context/keys.js";
import { createStepStartedEvent } from "#core/protocol/message.js";
import type { RecoveryStage, StepServices } from "#core/step-services.js";
import { extractWorkflowStreamWriteErrorDetails } from "#core/workflow-stream-error.js";
import {
  extractModelCallErrorDetails,
  extractUpstreamRejectionMessage,
} from "#core/model-call-error.js";
import { toErrorMessage } from "#core/shared/errors.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { createErrorId, createLogger, formatError, recordErrorOnSpan } from "#internal/logging.js";
import {
  hydrateSandboxAttachments,
  stageAttachmentsToSandbox,
} from "#harness/attachment-staging.js";
import { compactMessages, resolveCompactionModel } from "#core/compaction.js";
import { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import {
  buildGatewayAttributionHeaders,
  createModelCallRunner,
  environment,
  eveVersion,
  resolveActiveRuntimeModel,
} from "#harness/model-call.js";
import {
  attemptEmptyResponseRecovery,
  attemptUnsupportedProviderToolRecovery,
  buildModelCallFailureDetails,
  buildModelCallFailureLogFields,
} from "#core/model-call-recovery.js";
import {
  enrichTelemetry,
  ensureOtelIntegration,
  resolveStepOtelContext,
  setTurnTraceState,
} from "#harness/otel-integration.js";
import type { GenerateConfig } from "#core/step-types.js";
import { continuePendingWorkflowInterrupt } from "#core/workflow-interrupt-continuation.js";
import { summarizeKnownError } from "#core/semantic-errors/index.js";
import { readToolInterrupt } from "#core/tool-interrupts.js";

const log = createLogger("harness.generate");

/** Builds the host services used by the concrete core step program. */
export function createStepServices(config: GenerateConfig): StepServices {
  const telemetryConfig = getInstrumentationConfig();
  if (telemetryConfig !== undefined) {
    ensureOtelIntegration();
  }
  const tracer = telemetryConfig !== undefined ? trace.getTracer("eve") : undefined;
  const agentName = config.runtimeIdentity?.agentName;
  const telemetry = enrichTelemetry(telemetryConfig, agentName) ?? undefined;

  return {
    ambient: {
      current: () => contextStorage.getStore(),
      dynamicInstructionEntries: (ctx) => buildDynamicInstructionMessages(ctx),
      hasParentSession: (ctx) => ctx.get(ParentSessionKey) !== undefined,
      isScheduleAuth: (ctx) => isScheduleAppAuth(ctx.get(AuthKey)),
      readToolInterrupt(callId) {
        const ctx = contextStorage.getStore();
        return ctx === undefined ? undefined : readToolInterrupt(ctx, callId);
      },
      skillAnnouncementEntry(ctx) {
        const announcement = ctx.get(PendingSkillAnnouncementKey);
        return announcement === undefined || announcement.length === 0
          ? undefined
          : { content: announcement, role: "system" };
      },
    },

    attachments: {
      hydrate: (history) => hydrateSandboxAttachments([...history]),
      stage: (content) => stageAttachmentsToSandbox(content),
    },

    failure: {
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
              formatError,
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
    },

    log: {
      error: (message, fields) => log.error(message, fields),
      warn: (message, fields) => log.warn(message, fields),
    },

    modelCall: {
      attributionHeaders: (model) => buildGatewayAttributionHeaders(model, config.runtimeIdentity),

      compact: ({ compactionModel, history, state }) =>
        compactMessages(
          [...history],
          compactionModel.model,
          state.compaction,
          async (input) =>
            (
              await generateText({
                ...input,
                telemetry: telemetry ? { ...telemetry, functionId: "eve.compaction" } : undefined,
                temperature: 0,
              })
            ).text,
          compactionModel.providerOptions,
          buildGatewayAttributionHeaders(compactionModel.model, config.runtimeIdentity),
          config.abortSignal,
        ),

      continueWorkflowInterrupt: ({ emissionState, input, prompt }) =>
        continuePendingWorkflowInterrupt({
          childResults: input?.runtimeActionResults,
          config,
          emit: config.handleEvent,
          emissionState,
          log,
          session: prompt.session,
        }),

      create({ emissionState, prompt }) {
        return createModelCallRunner({
          agentName,
          approvedTools: prompt.approvedTools,
          attributionHeaders: prompt.attributionHeaders,
          cachePath: prompt.cachePath,
          config,
          ctx: prompt.ctx,
          emissionState,
          emit: config.handleEvent,
          marker: prompt.marker,
          model: prompt.model,
          modelMessages: prompt.modelMessages,
          session: prompt.session,
          systemMessages: prompt.systemMessages,
          telemetryConfig,
        });
      },

      currentState: (runner) => runner.currentSession(),

      dispatchDynamicModel:
        config.dispatchDynamicModelEvent === undefined
          ? undefined
          : async ({ ctx, emissionState, history, state }) => {
              await config.dispatchDynamicModelEvent?.({
                ctx,
                event: createStepStartedEvent({
                  sequence: emissionState.sequence,
                  stepIndex: emissionState.stepIndex,
                  turnId: emissionState.turnId,
                }),
                fallback: state.agent.dynamicModelDefaultReference ?? state.agent.modelReference,
                messages: history,
              });
            },

      formatModelId: (model) => formatLanguageModelGatewayId(model),

      prepareAttempt: (runner) => runner.prepareModelCallInput(),

      recoveryStages: createRecoveryStages(),

      async resolveActive({ ctx, state }) {
        const resolved = await resolveActiveRuntimeModel({ config, ctx, session: state });
        return { model: resolved.model, state: resolved.session };
      },

      resolveCompaction: ({ model, state }) =>
        resolveCompactionModel({
          compactionModelReference: state.agent.compactionModelReference,
          model,
          modelReference: state.agent.modelReference,
          resolveModel: config.resolveModel,
        }),

      run: ({ attempt, runner }) =>
        runner.runOneModelCall({
          preparedInput: attempt,
          suppressStepStartedEmission: true,
        }),
    },

    trace: {
      bind: ({ state, trace: turnSpan }) => setTurnTraceState(state, turnSpan.spanContext()),

      end(turnSpan) {
        turnSpan.end();
      },

      identity: {
        environment,
        eveVersion,
        functionId: telemetryConfig?.functionId ?? agentName,
      },

      async inContext({ state, trace: turnSpan }, run) {
        const parentContext = resolveStepOtelContext(tracer, turnSpan, state);
        return parentContext ? await otelContext.with(parentContext, run) : await run();
      },

      recordError(turnSpan, error) {
        recordErrorOnSpan(turnSpan, error);
      },

      setAttribute(turnSpan, key, value) {
        turnSpan.setAttribute(key, value);
      },

      start(name, attributes) {
        return tracer === undefined ? undefined : tracer.startSpan(name, { attributes });
      },
    },

    usage: {
      async publish({ runner, snapshot }) {
        let modelTag: string | undefined;
        try {
          modelTag = formatLanguageModelGatewayId(runner.prompt.model);
        } catch {
          modelTag = undefined;
        }
        await config.writeEveAttributes?.({
          "$eve.cache_read_tokens": snapshot.cacheReadTokens,
          "$eve.cache_write_tokens": snapshot.cacheWriteTokens,
          "$eve.cost_usd": snapshot.sawCost ? snapshot.costUsd : undefined,
          "$eve.input_tokens": snapshot.inputTokens,
          "$eve.model": modelTag,
          "$eve.output_tokens": snapshot.outputTokens,
          "$eve.tool_count": config.tools.size,
        });
      },
    },
  };
}

function createRecoveryStages(): readonly RecoveryStage[] {
  return [
    async ({ error, runner }) =>
      asStageResult(
        await attemptUnsupportedProviderToolRecovery({
          error,
          log,
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
          log,
          retryCallOptions: retryOptions,
          runOneModelCall: runner.modelCall.runOneModelCall,
          sessionId: runner.prompt.session.sessionId,
          turnId: runner.emissionState.turnId,
        }),
      ),
  ];
}

function asStageResult(
  outcome:
    | Awaited<ReturnType<typeof attemptUnsupportedProviderToolRecovery>>
    | Awaited<ReturnType<typeof attemptEmptyResponseRecovery>>,
): Awaited<ReturnType<RecoveryStage>> {
  if (outcome.outcome === "failed") {
    return {
      error: outcome.error,
      outcome: "failed",
      retryOptions: outcome.retryCallOptions,
    };
  }
  return outcome;
}

export type {
  PreparedModelCall,
  StepCallRunner as HarnessCallRunner,
} from "#core/step-services.js";
