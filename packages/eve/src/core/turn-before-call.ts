import type { ModelMessage, SystemModelMessage } from "ai";

import {
  createActionResultEvent,
  createCompactionCompletedEvent,
  createCompactionRequestedEvent,
} from "#core/protocol/message.js";
import {
  emitTurnEpilogue,
  emitTurnPreamble,
  getHarnessEmissionState,
  setHarnessEmissionState,
  type HarnessEmissionState,
} from "#core/emission.js";
import {
  consumeDeferredStepInput,
  getApprovedTools,
  getPendingInputRequestIds,
  hasStepInput,
  resolvePendingInput,
} from "#core/input-requests.js";
import { normalizeUserContent } from "#core/messages.js";
import { getInputTokenCount, shouldCompact } from "#core/compaction.js";
import { detectPromptCachePath, getAnthropicCacheMarker } from "#core/prompt-cache.js";
import { resolvePendingRuntimeActions } from "#core/runtime-actions.js";
import { applySessionLimitContinuation } from "#core/session-limit-enforcement.js";
import { convertStaleResponsesToUserMessage } from "#core/stale-input-responses.js";
import type { PreparedModelCall, StepServices } from "#core/step-services.js";
import { classifyParkedSession } from "#core/step-outcome.js";
import { resolveApprovalKeyFromTools } from "#core/tool-approval.js";
import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#core/shared/empty-delivery.js";
import type {
  GenerateConfig,
  GenerateOutcome,
  HarnessSession,
  StepInput,
} from "#core/step-types.js";
import type { Span } from "#compiled/@opentelemetry/api/index.js";

export type TurnInputResolution =
  | { readonly kind: "settled"; readonly outcome: GenerateOutcome }
  | ({ readonly kind: "resolved" } & ResolvedTurnInput);

export interface ResolvedTurnInput {
  readonly consumedMessage?: boolean;
  readonly deferredContext?: boolean;
  readonly deferredMessage?: boolean;
  readonly effectiveInput: StepInput | undefined;
  readonly emissionState: HarnessEmissionState;
  readonly history: readonly ModelMessage[];
  readonly state: HarnessSession;
}

/**
 * Resolves deferred input, runtime actions, stale responses, pending input,
 * and session-limit continuation before prompt assembly.
 */
export async function resolveTurnInput(input: {
  readonly config: GenerateConfig;
  readonly input: StepInput | undefined;
  readonly services: StepServices;
  readonly state: HarnessSession;
  readonly trace: Span | undefined;
}): Promise<TurnInputResolution> {
  const { config, services } = input;
  const emit = config.handleEvent;
  let state = input.state;
  let emissionState = getHarnessEmissionState(state.state);

  const deferred = consumeDeferredStepInput({ input: input.input, session: state });
  state = deferred.session;

  const actions = await resolvePendingRuntimeActions({
    emit,
    session: state,
    stepInput: deferred.input,
  });
  if (actions.outcome === "unresolved") {
    return settled(classifyParkedSession(actions.session));
  }
  state = actions.session;

  const conversion = convertStaleResponsesToUserMessage({
    history: actions.messages,
    pendingRequestIds: getPendingInputRequestIds(state.state),
    stepInput: deferred.input,
  });
  const effectiveInput = conversion.stepInput;
  const displayInput =
    conversion.kind === "converted"
      ? { ...effectiveInput, message: conversion.displayMessage }
      : effectiveInput;

  const pending = resolvePendingInput({
    history: actions.messages,
    resolveApprovalKey: resolveApprovalKeyFromTools(config.tools),
    session: state,
    stepInput: effectiveInput,
  });
  if (pending.outcome === "unresolved") {
    if (emit !== undefined && pending.deferredMessage === true && hasStepInput(input.input)) {
      emissionState = await emitTurnPreamble(
        emit,
        displayInput ?? {},
        emissionState,
        config.runtimeIdentity,
      );
      emissionState = await emitTurnEpilogue(
        emit,
        emissionState,
        config.mode,
        pending.session.continuationToken,
      );
      return settled(
        classifyParkedSession(setHarnessEmissionState(pending.session, emissionState)),
      );
    }

    return settled(classifyParkedSession(pending.session));
  }

  if (emit !== undefined && pending.rejectedActions !== undefined) {
    for (const result of pending.rejectedActions.results) {
      await emit(
        createActionResultEvent({
          rejected: true,
          result,
          sequence: pending.rejectedActions.event.sequence,
          stepIndex: pending.rejectedActions.event.stepIndex,
          turnId: pending.rejectedActions.event.turnId,
        }),
      );
    }
  }

  if (emit !== undefined && hasStepInput(input.input)) {
    emissionState = await emitTurnPreamble(
      emit,
      displayInput ?? {},
      emissionState,
      config.runtimeIdentity,
    );
    if (input.trace !== undefined) {
      services.trace.setAttribute(input.trace, "eve.turn.id", emissionState.turnId);
    }
  }

  const continuation = await applySessionLimitContinuation({
    config,
    emit,
    emissionState,
    limitContinuation: pending.limitContinuation,
    session: pending.session,
  });
  if (continuation.result !== null) {
    return settled(continuation.result);
  }

  return {
    consumedMessage: pending.consumedMessage,
    deferredContext: pending.deferredContext,
    deferredMessage: pending.deferredMessage,
    effectiveInput,
    emissionState,
    history: pending.messages,
    kind: "resolved",
    state: continuation.session,
  };
}

function settled(outcome: GenerateOutcome): TurnInputResolution {
  return { kind: "settled", outcome };
}

/**
 * Builds the durable prompt and its transient model-facing projection.
 */
export async function assemblePrompt(input: {
  readonly config: GenerateConfig;
  readonly resolved: ResolvedTurnInput;
  readonly services: StepServices;
}): Promise<PreparedModelCall> {
  const { config, resolved, services } = input;
  const emit = config.handleEvent;
  let state = resolved.state;
  const { emissionState } = resolved;
  let history = [...resolved.history];

  if (resolved.effectiveInput?.context !== undefined && resolved.deferredContext !== true) {
    for (const entry of resolved.effectiveInput.context) {
      history.push({ content: entry, role: "user" });
    }
  }

  const deliveryContent = normalizeUserContent(resolved.effectiveInput?.message);
  if (
    deliveryContent !== undefined &&
    resolved.deferredMessage !== true &&
    resolved.consumedMessage !== true
  ) {
    history.push({ content: await services.attachments.stage(deliveryContent), role: "user" });
  }

  const ctx = services.ambient.current();
  if (ctx !== undefined && services.modelCall.dispatchDynamicModel !== undefined) {
    await services.modelCall.dispatchDynamicModel({ ctx, emissionState, history, state });
  }
  const resolvedModel = await services.modelCall.resolveActive({ ctx, state });
  state = resolvedModel.state;
  const model = resolvedModel.model;
  const cachePath = detectPromptCachePath(model);
  const marker = cachePath.kind === "anthropic-direct" ? getAnthropicCacheMarker() : undefined;
  const attributionHeaders = services.modelCall.attributionHeaders(model);

  if (shouldCompact(history, state.compaction)) {
    const compactionModel = await services.modelCall.resolveCompaction({ model, state });
    if (emit !== undefined) {
      await emit(
        createCompactionRequestedEvent({
          modelId: services.modelCall.formatModelId(compactionModel.model),
          sequence: emissionState.sequence,
          sessionId: state.sessionId,
          turnId: emissionState.turnId,
          usageInputTokens: getInputTokenCount(history, state.compaction),
        }),
      );
    }
    history = [...(await services.modelCall.compact({ compactionModel, history, state }))];
    history.push(...(config.onCompaction?.() ?? []));
    if (emit !== undefined) {
      await emit(
        createCompactionCompletedEvent({
          modelId: services.modelCall.formatModelId(compactionModel.model),
          sequence: emissionState.sequence,
          sessionId: state.sessionId,
          turnId: emissionState.turnId,
        }),
      );
    }
  }

  const emptyDeliveryEnabled =
    state.outputSchema === undefined &&
    ctx !== undefined &&
    services.ambient.isScheduleAuth(ctx) &&
    !services.ambient.hasParentSession(ctx);

  const hydrated = await services.attachments.hydrate(history);
  const systemMessages: SystemModelMessage[] = [];
  const modelMessages: ModelMessage[] = [];
  for (const entry of hydrated) {
    if (entry.role === "system") {
      systemMessages.push(entry);
    } else {
      modelMessages.push(entry);
    }
  }
  if (ctx !== undefined) {
    systemMessages.push(...services.ambient.dynamicInstructionEntries(ctx));
    const skillAnnouncement = services.ambient.skillAnnouncementEntry(ctx);
    if (skillAnnouncement !== undefined) {
      systemMessages.push(skillAnnouncement);
    }
  }
  if (emptyDeliveryEnabled) {
    systemMessages.push({ content: CONDITIONAL_DELIVERY_INSTRUCTION, role: "system" });
  }

  return {
    approvedTools: getApprovedTools(state),
    attributionHeaders,
    cachePath,
    ctx,
    emptyDeliveryEnabled,
    marker,
    messages: history,
    model,
    modelMessages,
    session: state,
    systemMessages,
  };
}
