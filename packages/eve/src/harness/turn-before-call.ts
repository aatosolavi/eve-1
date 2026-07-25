import type { SystemModelMessage, TelemetryOptions } from "ai";
import { isScheduleAppAuth } from "#channel/schedule-auth.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, ParentSessionKey } from "#core/context/keys.js";
import { buildDynamicInstructionMessages } from "#context/dynamic-instruction-lifecycle.js";
import { PendingSkillAnnouncementKey } from "#context/dynamic-skill-lifecycle.js";
import type {
  CompactionDependencies,
  ModelDependencies,
  PromptDependencies,
  WaitDependencies,
} from "#core/step-ports.js";
import { createStepStartedEvent } from "#protocol/message.js";
import {
  hydrateSandboxAttachments,
  stageAttachmentsToSandbox,
} from "#harness/attachment-staging.js";
import { compactMessages, resolveCompactionModel, shouldCompact } from "#harness/compaction.js";
import {
  consumeDeferredStepInput,
  getApprovedTools,
  getPendingInputRequestIds,
  resolvePendingInput,
} from "#harness/input-requests.js";
import { buildGatewayAttributionHeaders, resolveActiveRuntimeModel } from "#harness/model-call.js";
import { detectPromptCachePath, getAnthropicCacheMarker } from "#harness/prompt-cache.js";
import { resolvePendingRuntimeActions } from "#harness/runtime-actions.js";
import { applySessionLimitContinuation } from "#harness/session-limit-enforcement.js";
import { convertStaleResponsesToUserMessage } from "#harness/stale-input-responses.js";
import type { HarnessStepFlow } from "#harness/step-flow.js";
import { resolveApprovalKeyFromTools } from "#harness/step-result.js";
import type { GenerateConfig } from "#harness/types.js";
import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#shared/empty-delivery.js";

/**
 * The pre-call dependencies of the core step flow: the wait subsystems of
 * turn-input resolution and the prompt-assembly, model-resolution, and
 * compaction primitives. Sequencing, gating, and choreography live in
 * `core/turn-before-call.ts`; this module only binds each dependency to
 * its harness subsystem.
 */

/** Binds the turn-input wait subsystems. */
export function createWaitDependencies(config: GenerateConfig): WaitDependencies<HarnessStepFlow> {
  const emit = config.handleEvent;

  return {
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

    consumeDeferredInput({ input, state }) {
      const consumed = consumeDeferredStepInput({ input, session: state });
      return { input: consumed.input, state: consumed.session };
    },

    convertStaleResponses({ history, input, state }) {
      const conversion = convertStaleResponsesToUserMessage({
        history: [...history],
        pendingRequestIds: getPendingInputRequestIds(state.state),
        stepInput: input,
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

    resolvePendingInput({ history, input, state }) {
      const pending = resolvePendingInput({
        history: [...history],
        resolveApprovalKey: resolveApprovalKeyFromTools(config.tools),
        session: state,
        stepInput: input,
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

    async resolveRuntimeActions({ input, state }) {
      const resolved = await resolvePendingRuntimeActions({
        emit,
        session: state,
        stepInput: input,
      });
      if (resolved.outcome === "unresolved") {
        return { outcome: "unresolved", state: resolved.session };
      }
      return { history: resolved.messages, outcome: "resolved", state: resolved.session };
    },
  };
}

/** Binds the prompt-assembly primitives. */
export function createPromptDependencies(): PromptDependencies<HarnessStepFlow> {
  return {
    conditionalDeliveryEntry: () => ({ content: CONDITIONAL_DELIVERY_INSTRUCTION, role: "system" }),

    dynamicInstructionEntries: (ctx) => buildDynamicInstructionMessages(ctx),

    finalize(input) {
      return {
        approvedTools: getApprovedTools(input.state),
        attributionHeaders: input.attributionHeaders,
        cachePath: input.cachePath,
        ctx: input.ctx,
        emptyDeliveryEnabled: input.emptyDeliveryEnabled,
        marker: input.cacheMarker,
        messages: [...input.history],
        model: input.model,
        modelMessages: [...input.modelEntries],
        session: input.state,
        // Safe: the core flow routes only `isSystemEntry` entries and
        // system-typed sources onto the system channel.
        systemMessages: [...input.systemEntries] as SystemModelMessage[],
      };
    },

    hydrate: (history) => hydrateSandboxAttachments([...history]),

    isSystemEntry: (entry) => entry.role === "system",

    skillAnnouncementEntry(ctx) {
      const announcement = ctx.get(PendingSkillAnnouncementKey);
      if (announcement === undefined || announcement.length === 0) {
        return undefined;
      }
      return { content: announcement, role: "system" };
    },

    stageAttachments: (content) => stageAttachmentsToSandbox(content),

    userEntry: (content) => ({ content, role: "user" }),
  };
}

/** Binds model resolution and the ambient-context facets. */
export function createModelDependencies(
  config: GenerateConfig,
): ModelDependencies<HarnessStepFlow> {
  return {
    // Direct harness unit tests may run without an ambient context.
    ambient: () => contextStorage.getStore(),

    anthropicCacheMarker: () => getAnthropicCacheMarker(),

    attributionHeaders: (model) => buildGatewayAttributionHeaders(model, config.runtimeIdentity),

    cachePlan(model) {
      const path = detectPromptCachePath(model);
      return { kind: path.kind, path };
    },

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

    hasParentSession: (ctx) => ctx.get(ParentSessionKey) !== undefined,

    isScheduleAuth: (ctx) => isScheduleAppAuth(ctx.get(AuthKey)),

    async resolve({ ctx, state }) {
      const resolved = await resolveActiveRuntimeModel({ config, ctx, session: state });
      return { model: resolved.model, state: resolved.session };
    },
  };
}

/** Binds the compaction primitives. */
export function createCompactionDependencies(input: {
  readonly config: GenerateConfig;
  readonly telemetry: TelemetryOptions | undefined;
}): CompactionDependencies<HarnessStepFlow> {
  const { config, telemetry } = input;

  return {
    postCompactionEntries: () =>
      config.onCompaction === undefined ? [] : [...config.onCompaction()],

    resolveModel: ({ model, state }) =>
      resolveCompactionModel({
        compactionModelReference: state.agent.compactionModelReference,
        model,
        modelReference: state.agent.modelReference,
        resolveModel: config.resolveModel,
      }),

    run: ({ compactionModel, history, state }) =>
      compactMessages(
        [...history],
        compactionModel.model,
        state.compaction,
        compactionModel.providerOptions,
        telemetry,
        buildGatewayAttributionHeaders(compactionModel.model, config.runtimeIdentity),
        config.abortSignal,
      ),

    shouldCompact: (history, state) => shouldCompact([...history], state.compaction),
  };
}
