import {
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type TelemetryOptions,
} from "ai";
import { isScheduleAppAuth } from "#channel/schedule-auth.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, ParentSessionKey } from "#context/keys.js";
import { buildDynamicInstructionMessages } from "#context/dynamic-instruction-lifecycle.js";
import { PendingSkillAnnouncementKey } from "#context/dynamic-skill-lifecycle.js";
import type { BeforeCallPorts } from "#core/turn-before-call.js";
import { formatLanguageModelGatewayId } from "#internal/runtime-model.js";
import {
  createActionResultEvent,
  createCompactionCompletedEvent,
  createCompactionRequestedEvent,
  createStepStartedEvent,
} from "#protocol/message.js";
import {
  hydrateSandboxAttachments,
  stageAttachmentsToSandbox,
} from "#harness/attachment-staging.js";
import {
  compactMessages,
  getInputTokenCount,
  resolveCompactionModel,
  shouldCompact,
} from "#harness/compaction.js";
import {
  emitTurnEpilogue,
  emitTurnPreamble,
  getHarnessEmissionState,
  setHarnessEmissionState,
  type HarnessEmissionState,
} from "#harness/emission.js";
import {
  consumeDeferredStepInput,
  getApprovedTools,
  getPendingInputRequestIds,
  hasStepInput,
  resolvePendingInput,
} from "#harness/input-requests.js";
import { normalizeUserContent } from "#harness/messages.js";
import { buildGatewayAttributionHeaders, resolveActiveRuntimeModel } from "#harness/model-call.js";
import { detectPromptCachePath, getAnthropicCacheMarker } from "#harness/prompt-cache.js";
import { resolvePendingRuntimeActions } from "#harness/runtime-actions.js";
import { applySessionLimitContinuation } from "#harness/session-limit-enforcement.js";
import { convertStaleResponsesToUserMessage } from "#harness/stale-input-responses.js";
import type { HarnessStepFlow, TurnSpanCell } from "#harness/step-flow.js";
import { classifyParkedSession, resolveApprovalKeyFromTools } from "#harness/step-result.js";
import type { GenerateConfig, HarnessSession } from "#harness/types.js";
import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#shared/empty-delivery.js";

/**
 * The pre-call ports of the core step flow, bound to the harness: every
 * effect {@link import("#core/turn-before-call.js").resolveTurnInput} and
 * {@link import("#core/turn-before-call.js").assemblePrompt} sequence.
 * The sequencing and settle points live in core; the concrete type
 * binding lives in {@link HarnessStepFlow}.
 */
export function createBeforeCallPorts(input: {
  readonly config: GenerateConfig;
  readonly telemetry: TelemetryOptions | undefined;
  /** The step's turn-span slot, tagged with the turn id once the preamble emits. */
  readonly turnSpan: TurnSpanCell;
}): BeforeCallPorts<HarnessStepFlow> {
  const { config, telemetry, turnSpan } = input;
  const emit = config.handleEvent;

  return {
    // --- Stage 1: turn-input resolution -----------------------------------

    emissionEnabled: emit !== undefined,

    readEmissionState(state) {
      return getHarnessEmissionState(state.state);
    },

    consumeDeferredInput({ input: stepInput, state }) {
      const consumed = consumeDeferredStepInput({ input: stepInput, session: state });
      return { input: consumed.input, state: consumed.session };
    },

    async resolveRuntimeActions({ input: stepInput, state }) {
      const resolved = await resolvePendingRuntimeActions({ emit, session: state, stepInput });
      if (resolved.outcome === "unresolved") {
        return { outcome: "unresolved", state: resolved.session };
      }
      return { history: resolved.messages, outcome: "resolved", state: resolved.session };
    },

    convertStaleResponses({ history, input: stepInput, state }) {
      const conversion = convertStaleResponsesToUserMessage({
        history,
        pendingRequestIds: getPendingInputRequestIds(state.state),
        stepInput,
      });
      const effectiveInput = conversion.stepInput;
      return {
        displayInput:
          conversion.kind === "converted"
            ? { ...effectiveInput, message: conversion.displayMessage }
            : effectiveInput,
        effectiveInput,
      };
    },

    resolvePendingInput({ history, input: stepInput, state }) {
      const pending = resolvePendingInput({
        history,
        resolveApprovalKey: resolveApprovalKeyFromTools(config.tools),
        session: state,
        stepInput,
      });
      if (pending.outcome === "unresolved") {
        return {
          deferredMessage: pending.deferredMessage,
          outcome: "unresolved",
          state: pending.session,
        };
      }
      return {
        consumedMessage: pending.consumedMessage,
        deferredContext: pending.deferredContext,
        deferredMessage: pending.deferredMessage,
        history: pending.messages,
        limitGrant: pending.limitContinuation,
        outcome: "resolved",
        rejectedApprovals: pending.rejectedActions,
        state: pending.session,
      };
    },

    // Surface denied tool-call approvals as rejected `action.result` events.
    // The denial otherwise lives only in model history, so consumers (e.g.
    // observability) never see the tool call resolve. Attributed to the turn
    // that requested approval via the parked batch's emit coordinates.
    async emitRejectedApprovals(rejected) {
      if (emit === undefined || rejected === undefined) {
        return;
      }
      for (const result of rejected.results) {
        await emit(
          createActionResultEvent({
            rejected: true,
            result,
            sequence: rejected.event.sequence,
            stepIndex: rejected.event.stepIndex,
            turnId: rejected.event.turnId,
          }),
        );
      }
    },

    async emitTurnPreamble({ emissionState, input: stepInput }) {
      if (emit === undefined) {
        return emissionState;
      }
      return await emitTurnPreamble(emit, stepInput ?? {}, emissionState, config.runtimeIdentity);
    },

    async emitTurnEpilogue({ emissionState, state }) {
      if (emit === undefined) {
        return emissionState;
      }
      return await emitTurnEpilogue(emit, emissionState, config.mode, state.continuationToken);
    },

    onTurnStarted(emissionState) {
      turnSpan.current?.setAttribute("eve.turn.id", emissionState.turnId);
    },

    // A resolved session-limit continuation prompt grants a fresh token
    // budget or ends the session; see session-limit-enforcement.
    async applyLimitContinuation({ emissionState, limitGrant, state }) {
      const continuation = await applySessionLimitContinuation({
        config,
        emit,
        emissionState,
        limitContinuation: limitGrant,
        session: state,
      });
      return { outcome: continuation.result, state: continuation.session };
    },

    classifyParked({ emissionState, state }) {
      return classifyParkedSession(
        emissionState === undefined ? state : setHarnessEmissionState(state, emissionState),
      );
    },

    hasDeliveryInput(stepInput) {
      return hasStepInput(stepInput);
    },

    // --- Stage 2: prompt assembly ------------------------------------------

    appendDeliveryContext({ history, input: stepInput, skipContext }) {
      if (stepInput?.context !== undefined && !skipContext) {
        for (const entry of stepInput.context) {
          history.push({ content: entry, role: "user" });
        }
      }
      return history;
    },

    async stageDeliveryMessage({ history, input: stepInput, skipMessage }) {
      const userContent = normalizeUserContent(stepInput?.message);
      if (userContent !== undefined && !skipMessage) {
        // Staging writes FilePart bytes into the sandbox and replaces
        // each part's `data` with a compact `eve-sandbox:` URL. The
        // `history` array — and everything that flows into
        // `session.history` from it — therefore never carries raw
        // attachment bytes across step boundaries.
        const content = await stageAttachmentsToSandbox(userContent);
        history.push({ content, role: "user" });
      }
      return history;
    },

    async resolveActiveModel({ emissionState, history, state }) {
      // Direct harness unit tests may run without an ambient context.
      const ctx = contextStorage.getStore();
      if (ctx !== undefined && config.dispatchDynamicModelEvent !== undefined) {
        await config.dispatchDynamicModelEvent({
          ctx,
          event: createStepStartedEvent({
            sequence: emissionState.sequence,
            stepIndex: emissionState.stepIndex,
            turnId: emissionState.turnId,
          }),
          fallback: state.agent.dynamicModelDefaultReference ?? state.agent.modelReference,
          messages: history,
        });
      }
      const resolved = await resolveActiveRuntimeModel({ config, ctx, session: state });
      const model = resolved.model;
      const cachePath = detectPromptCachePath(model);
      return {
        environment: {
          attributionHeaders: buildGatewayAttributionHeaders(model, config.runtimeIdentity),
          cachePath,
          ctx,
          marker: cachePath.kind === "anthropic-direct" ? getAnthropicCacheMarker() : undefined,
          model,
        },
        state: resolved.session,
      };
    },

    async compactIfNeeded({ emissionState, environment, history, state }) {
      const compacted = await maybeCompact({
        abortSignal: config.abortSignal,
        emit,
        emissionState,
        messages: history,
        model: environment.model,
        onCompaction: config.onCompaction,
        resolveModel: config.resolveModel,
        runtimeIdentity: config.runtimeIdentity,
        session: state,
        telemetry,
      });
      return { history: compacted.messages, state: compacted.session };
    },

    async assembleModelPrompt({ environment, history, state }) {
      const { ctx } = environment;
      const emptyDeliveryEnabled =
        state.outputSchema === undefined &&
        ctx !== undefined &&
        isScheduleAppAuth(ctx.get(AuthKey)) &&
        ctx.get(ParentSessionKey) === undefined;

      // Hydrate `eve-sandbox:` ref FileParts into inline bytes for the
      // model call only. The result is transient — `history` itself
      // remains ref-only so it can flow into `session.history` without
      // bloating every future step boundary.
      const hydratedMessages = await hydrateSandboxAttachments(history);

      // AI SDK rejects role:"system" in `messages` — route system entries
      // from durable history to `instructions` instead.
      const systemMessages: SystemModelMessage[] = [];
      const modelMessages: ModelMessage[] = [];
      for (const entry of hydratedMessages) {
        if (entry.role === "system") {
          systemMessages.push(entry);
        } else {
          modelMessages.push(entry);
        }
      }
      if (ctx !== undefined) {
        systemMessages.push(...buildDynamicInstructionMessages(ctx));
        const skillAnnouncement = ctx.get(PendingSkillAnnouncementKey);
        if (skillAnnouncement !== undefined && skillAnnouncement.length > 0) {
          systemMessages.push({ role: "system", content: skillAnnouncement });
        }
      }
      if (emptyDeliveryEnabled) {
        systemMessages.push({ role: "system", content: CONDITIONAL_DELIVERY_INSTRUCTION });
      }

      return {
        approvedTools: getApprovedTools(state),
        attributionHeaders: environment.attributionHeaders,
        cachePath: environment.cachePath,
        ctx,
        emptyDeliveryEnabled,
        marker: environment.marker,
        messages: history,
        model: environment.model,
        modelMessages,
        session: state,
        systemMessages,
      };
    },
  };
}

/**
 * Runs the compaction pipeline once if the session's input-token estimate
 * is over the configured threshold. Mutates neither input; returns the new
 * messages array and (possibly updated) session.
 *
 * Kept in the tool-loop (rather than the AI SDK's `prepareStep` hook) so
 * the compacted messages flow through the same `messages` variable the
 * harness uses to rebuild `session.history` after the step.
 */
async function maybeCompact(input: {
  readonly abortSignal?: AbortSignal;
  readonly emit?: GenerateConfig["handleEvent"];
  readonly emissionState: HarnessEmissionState;
  readonly messages: ModelMessage[];
  readonly model: LanguageModel;
  readonly onCompaction?: GenerateConfig["onCompaction"];
  readonly resolveModel: GenerateConfig["resolveModel"];
  readonly runtimeIdentity?: GenerateConfig["runtimeIdentity"];
  readonly session: HarnessSession;
  readonly telemetry?: TelemetryOptions;
}): Promise<{ readonly messages: ModelMessage[]; readonly session: HarnessSession }> {
  const { emit, emissionState } = input;
  let messages = input.messages;
  const session = input.session;

  if (!shouldCompact(messages, session.compaction)) {
    return { messages, session };
  }

  const compaction = await resolveCompactionModel({
    compactionModelReference: session.agent.compactionModelReference,
    model: input.model,
    modelReference: session.agent.modelReference,
    resolveModel: input.resolveModel,
  });

  if (emit) {
    await emit(
      createCompactionRequestedEvent({
        modelId: formatLanguageModelGatewayId(compaction.model),
        sequence: emissionState.sequence,
        sessionId: session.sessionId,
        turnId: emissionState.turnId,
        usageInputTokens: getInputTokenCount(messages, session.compaction),
      }),
    );
  }

  messages = await compactMessages(
    messages,
    compaction.model,
    session.compaction,
    compaction.providerOptions,
    input.telemetry,
    buildGatewayAttributionHeaders(compaction.model, input.runtimeIdentity),
    input.abortSignal,
  );

  if (input.onCompaction) {
    for (const msg of input.onCompaction()) {
      messages.push(msg);
    }
  }

  if (emit) {
    await emit(
      createCompactionCompletedEvent({
        modelId: formatLanguageModelGatewayId(compaction.model),
        sequence: emissionState.sequence,
        sessionId: session.sessionId,
        turnId: emissionState.turnId,
      }),
    );
  }

  return { messages, session };
}
