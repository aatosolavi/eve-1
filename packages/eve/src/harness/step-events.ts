import type { EventStream } from "#core/step-ports.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import { getInputTokenCount } from "#harness/compaction.js";
import {
  emitFailedStep,
  emitRecoverableFailedTurn,
  emitStepStarted,
  emitTurnEpilogue,
  emitTurnPreamble,
} from "#harness/emission.js";
import type { HarnessStepFlow } from "#harness/step-flow.js";
import type { GenerateConfig } from "#harness/types.js";
import {
  createActionResultEvent,
  createCompactionCompletedEvent,
  createCompactionRequestedEvent,
} from "#protocol/message.js";

/**
 * The event stream of the core step flow, bound to the harness emitters.
 * Each method builds and emits exactly one lifecycle event; the
 * choreography between events is core flow. Returns `undefined` when the
 * config carries no emitter — the core flow then skips every event site.
 */
export function createEventStream(
  config: GenerateConfig,
): EventStream<HarnessStepFlow> | undefined {
  const emit = config.handleEvent;
  if (emit === undefined) {
    return undefined;
  }

  return {
    async compactionCompleted({ compactionModel, emissionState, state }) {
      await emit(
        createCompactionCompletedEvent({
          modelId: formatLanguageModelGatewayId(compactionModel.model),
          sequence: emissionState.sequence,
          sessionId: state.sessionId,
          turnId: emissionState.turnId,
        }),
      );
    },

    async compactionRequested({ compactionModel, emissionState, history, state }) {
      await emit(
        createCompactionRequestedEvent({
          modelId: formatLanguageModelGatewayId(compactionModel.model),
          sequence: emissionState.sequence,
          sessionId: state.sessionId,
          turnId: emissionState.turnId,
          usageInputTokens: getInputTokenCount([...history], state.compaction),
        }),
      );
    },

    async failedStep({ content, emissionState, state }) {
      await emitFailedStep(emit, emissionState, {
        code: content.code,
        details: content.details,
        message: content.message,
        sessionId: state.sessionId,
      });
    },

    async recoverableFailedTurn({ content, emissionState, state }) {
      return await emitRecoverableFailedTurn(emit, emissionState, {
        code: content.code,
        continuationToken: state.continuationToken,
        details: content.details,
        message: content.message,
      });
    },

    async rejectedApproval({ batch, result }) {
      await emit(
        createActionResultEvent({
          rejected: true,
          result,
          sequence: batch.event.sequence,
          stepIndex: batch.event.stepIndex,
          turnId: batch.event.turnId,
        }),
      );
    },

    async stepStarted({ emissionState, prompt }) {
      await emitStepStarted(emit, emissionState, prompt.messages);
    },

    async turnEpilogue({ emissionState, state }) {
      return await emitTurnEpilogue(emit, emissionState, config.mode, state.continuationToken);
    },

    async turnPreamble({ emissionState, input }) {
      return await emitTurnPreamble(emit, input ?? {}, emissionState, config.runtimeIdentity);
    },
  };
}
