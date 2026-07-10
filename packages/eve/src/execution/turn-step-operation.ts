import type { ModelMessage } from "ai";

import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, defaultDeliverResult } from "#channel/adapter.js";
import type { DeliverPayload, HookPayload } from "#channel/types.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { AuthKey, CapabilitiesKey, ContinuationTokenKey, ModeKey } from "#context/keys.js";
import { runStep } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import {
  createDurableSessionState,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-state.js";
import { createExecutionNodeStep } from "#execution/node-step.js";
import { hydrateDurableSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
  type AuthorizationResult,
} from "#harness/authorization.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { hasPendingInputBatch } from "#harness/input-requests.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import { getPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";
import { getPendingWorkflowInterrupt } from "#harness/workflow-interrupt-state.js";
import {
  getRuntimeActionKeysFromWorkflowInterrupt,
  isWorkflowRuntimeActionInterrupt,
} from "#harness/workflow-runtime-action-state.js";
import {
  createAuthorizationCompletedEvent,
  encodeMessageStreamEvent,
  type HandleMessageStreamEvent,
  type TimedHandleMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import { getRuntimeActionRequestKey } from "#runtime/actions/keys.js";
import type { AuthorizationCallback } from "#runtime/connections/types.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { JsonObject } from "#shared/json.js";
import type { RunMode } from "#shared/run-mode.js";

/** One transformed, timed, and encoded public event ready for acknowledged publication. */
export interface TurnStepEventPublication {
  readonly encoded: Uint8Array;
  readonly emissionOrdinal: number;
  readonly event: TimedHandleMessageStreamEvent;
}

/** Engine-neutral destination for one operation's public events. */
export interface TurnStepEventSink {
  write(publication: TurnStepEventPublication): Promise<void>;
}

/** Inputs required to execute one production harness step. */
export interface TurnStepOperationInput {
  readonly callbackBaseUrl?: string;
  readonly createEventSink: () => TurnStepEventSink;
  readonly durableSession: DurableSession;
  readonly input: HookPayload | undefined;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Result of one durable harness step, consumed by the turn runtime program.
 *
 * `park` carries `hasPendingInputBatch`, `hasPendingAuthorization`, and
 * `pendingRuntimeActionKeys` so the runtime program can pick the right
 * {@link import("#execution/next-driver-action.js").NextDriverAction}
 * arm without re-reading the session.
 */
export type DurableStepResult =
  | {
      readonly action: "continue" | "done";
      readonly output?: unknown;
      readonly isError?: boolean;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly action: "park";
      readonly authorizationNames?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly pendingRuntimeActionKeys?: readonly string[];
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly action: "dispatch-workflow-runtime-actions";
      readonly pendingRuntimeActionKeys: readonly string[];
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

/** Executes one production harness step without imposing a runtime boundary. */
export async function executeTurnStepOperation(
  operationInput: TurnStepOperationInput,
): Promise<DurableStepResult> {
  let input = operationInput.input;
  let durableSession = operationInput.durableSession;
  const ctx = await deserializeContext(operationInput.serializedContext);
  const adapter = ctx.require(ChannelKey);
  const bundle = ctx.require(BundleKey);

  if (operationInput.callbackBaseUrl !== undefined) {
    ctx.set(CallbackBaseUrlKey, operationInput.callbackBaseUrl);
  }

  // Authorization callback. If the delivery carries an
  // `authorizationCallback` and there's a pending authorization on
  // session state, extract it, build AuthorizationResult entries, and
  // populate PendingAuthorizationResultKey so tools can complete auth.
  // Strip the callback from the delivery so the adapter doesn't see it.
  // Completion event names are collected here; emission happens after
  // the `emit` function is created below.
  const pendingAuth = getPendingAuthorization(durableSession.state);
  let completedAuths:
    | Array<{ name: string; authorization: ConnectionAuthorizationChallenge }>
    | undefined;
  if (pendingAuth && input?.kind === "deliver") {
    const authResults: Array<{ name: string } & AuthorizationResult> = [];
    const completed: Array<{ name: string; authorization: ConnectionAuthorizationChallenge }> = [];
    const remainingPayloads: DeliverPayload[] = [];
    for (const payload of input.payloads) {
      const cb = payload["authorizationCallback"] as
        | { connectionName: string; callback: AuthorizationCallback }
        | undefined;
      if (cb) {
        const challenge = pendingAuth.challenges.find(
          (current) => current.name === cb.connectionName,
        );
        if (challenge) {
          authResults.push({
            name: challenge.name,
            resume: challenge.resume,
            callback: cb.callback,
            hookUrl: challenge.hookUrl,
          });
          completed.push({ name: challenge.name, authorization: challenge.challenge });
        }
      } else {
        remainingPayloads.push(payload);
      }
    }
    if (authResults.length > 0) {
      ctx.set(PendingAuthorizationResultKey, authResults);
      durableSession = {
        ...durableSession,
        state: clearPendingAuthorization(
          durableSession.state,
          authResults.map((result) => result.name),
        ),
      };
      completedAuths = completed;
      input = remainingPayloads.length > 0 ? { ...input, payloads: remainingPayloads } : undefined;
    }
  }

  // Apply deliver-time auth ferried through the runtime (initial-turn
  // input has no auth; it was seeded by buildRunContext).
  if (input?.kind === "deliver" && input.auth !== undefined) {
    ctx.set(AuthKey, input.auth ?? null);
  }

  const initialSession = hydrateDurableSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    durable: durableSession,
    turnAgent: bundle.turnAgent,
  });

  const adapterCtx = buildAdapterContext(adapter, ctx);

  // Run the adapter's deliver hook for each queued payload and
  // coalesce the resulting StepInput values.
  let resolved: StepInput | undefined;
  if (input?.kind === "deliver") {
    const results: StepInput[] = [];
    for (const payload of input.payloads) {
      const result = adapter.deliver
        ? await adapter.deliver(payload, adapterCtx)
        : defaultDeliverResult(payload);

      if (result !== undefined && result !== null) {
        results.push(result);
      }
    }
    resolved = results.length === 0 ? undefined : results.reduce(coalesceTurnInputs);
  } else if (input?.kind === "runtime-action-result") {
    resolved = { runtimeActionResults: input.results };
  }

  // Pin adapter-state mutations back onto ctx so they survive the
  // operation boundary.
  if (input?.kind === "deliver") {
    const updatedAdapter = { ...adapter, state: { ...adapterCtx.state } };
    setChannelContext(ctx, updatedAdapter);
  }

  // Adapter handled the delivery inline (e.g. a Slack interaction
  // that only edits a message). Re-park without a model turn; skip
  // the snapshot write when the session itself is unchanged.
  if (input?.kind === "deliver" && resolved === undefined) {
    const rekeyed = reconcileSessionContinuationToken(ctx, initialSession);
    const nextSerializedContext = serializeContext(ctx);
    const nextState =
      rekeyed === initialSession
        ? operationInput.sessionState
        : createDurableSessionState({ session: rekeyed });

    return {
      action: "park",
      ...derivePendingState(rekeyed),
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
  }

  const eventSink = operationInput.createEventSink();
  let emissionOrdinal = 0;
  const hookRegistry = bundle.hookRegistry;
  const dynamicInstructionsResolvers = bundle.resolvedAgent.dynamicInstructionsResolvers ?? [];
  const dynamicSkillResolvers = bundle.resolvedAgent.dynamicSkillResolvers ?? [];
  const dynamicToolResolvers = bundle.resolvedAgent.dynamicToolResolvers ?? [];

  const emit = async (event: HandleMessageStreamEvent): Promise<HandleMessageStreamEvent> => {
    const toEmit = await callAdapterEventHandler(adapter, event, adapterCtx);
    setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
    const timedEvent = timestampHandleMessageStreamEvent(toEmit);
    const encoded = encodeMessageStreamEvent(timedEvent);
    const currentEmissionOrdinal = emissionOrdinal++;
    await eventSink.write({
      encoded,
      emissionOrdinal: currentEmissionOrdinal,
      event: timedEvent,
    });
    return toEmit;
  };

  const handleEvent = async (
    event: HandleMessageStreamEvent,
    messages?: readonly ModelMessage[],
  ): Promise<void> => {
    const emitted = await emit(event);
    await dispatchStreamEventHooks({ ctx, registry: hookRegistry, event: emitted });
    await dispatchDynamicToolEvent({
      ctx,
      resolvers: dynamicToolResolvers,
      event: emitted,
      messages: messages ?? [],
    });
    await dispatchDynamicSkillEvent({
      ctx,
      resolvers: dynamicSkillResolvers,
      event: emitted,
      messages: messages ?? [],
    });
    await dispatchDynamicInstructionEvent({
      ctx,
      resolvers: dynamicInstructionsResolvers,
      event: emitted,
      messages: messages ?? [],
    });
  };

  const mode = ctx.require(ModeKey);

  let stepResult = await runStep(ctx, initialSession, async (enrichedSession) => {
    const schemaSession = resolveEffectiveOutputSchema({
      agentOutputSchema: bundle.turnAgent.outputSchema,
      input: resolved,
      mode,
      session: enrichedSession,
    });
    if (completedAuths) {
      const emissionState = getHarnessEmissionState(schemaSession.state);
      for (const { name, authorization } of completedAuths) {
        await handleEvent(
          createAuthorizationCompletedEvent({
            authorization,
            name,
            outcome: "authorized",
            sequence: emissionState.sequence,
            stepIndex: emissionState.stepIndex,
            turnId: emissionState.turnId,
          }),
        );
      }
    }

    const capabilities = ctx.get(CapabilitiesKey);

    const runHarnessStep = async (
      lifecycleSession: HarnessSession,
      stepInput: StepInput | undefined,
    ): Promise<StepResult> => {
      const refreshedSession = refreshSessionFromTurnAgent({
        compactionOverrides: {
          thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
        },
        session: lifecycleSession,
        turnAgent: bundle.turnAgent,
      });

      const step = createExecutionNodeStep({
        capabilities,
        handleEvent,
        mode,
        modelResolutionScope: {
          moduleMap: bundle.moduleMap,
          nodeId: bundle.nodeId,
        },
        node: bundle.graph.root,
      });
      return step(refreshedSession, stepInput);
    };

    return runHarnessStep(schemaSession, resolved);
  });

  // Re-stamp the in-memory session's continuation token in case a
  // handler called `setContinuationToken(...)` (eg. Slack auto-anchor).
  const rekeyed = reconcileSessionContinuationToken(ctx, stepResult.session);
  const nextSerializedContext = serializeContext(ctx);
  stepResult = { ...stepResult, session: rekeyed };

  const nextState = createDurableSessionState({ session: stepResult.session });

  if (
    stepResult.next !== null &&
    typeof stepResult.next === "object" &&
    "done" in stepResult.next
  ) {
    return {
      action: "done",
      output: stepResult.next.output,
      isError: stepResult.next.isError,
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
  }

  if (stepResult.next === null) {
    const workflowInterrupt = getPendingWorkflowInterrupt(stepResult.session.state);
    if (
      workflowInterrupt !== undefined &&
      isWorkflowRuntimeActionInterrupt(workflowInterrupt.interrupt)
    ) {
      return {
        action: "dispatch-workflow-runtime-actions",
        pendingRuntimeActionKeys: getRuntimeActionKeysFromWorkflowInterrupt(
          workflowInterrupt.interrupt,
        ),
        serializedContext: nextSerializedContext,
        sessionState: nextState,
      };
    }

    return {
      action: "park",
      ...derivePendingState(stepResult.session),
      serializedContext: nextSerializedContext,
      sessionState: nextState,
    };
  }

  return {
    action: "continue",
    serializedContext: nextSerializedContext,
    sessionState: nextState,
  };
}

/**
 * Derives the pending-state fields the turn runtime program needs to choose
 * the right `NextDriverAction` arm at the park boundary.
 */
function derivePendingState(session: HarnessSession): {
  readonly authorizationNames?: readonly string[];
  readonly hasPendingAuthorization: boolean;
  readonly hasPendingInputBatch: boolean;
  readonly pendingRuntimeActionKeys?: readonly string[];
} {
  const batch = getPendingRuntimeActionBatch(session.state);
  const pendingAuth = getPendingAuthorization(session.state);
  const base = {
    authorizationNames: pendingAuth?.challenges.map((challenge) => challenge.name),
    hasPendingAuthorization: pendingAuth !== undefined,
    hasPendingInputBatch: hasPendingInputBatch(session.state),
  };
  if (batch !== undefined) {
    return {
      ...base,
      pendingRuntimeActionKeys: batch.actions.map((action) => getRuntimeActionRequestKey(action)),
    };
  }
  return base;
}

/**
 * Re-stamps `session.continuationToken` from `ContinuationTokenKey`
 * after channels call `setContinuationToken(...)`. Idempotent when the
 * token is unchanged.
 */
export function reconcileSessionContinuationToken(
  ctx: Awaited<ReturnType<typeof deserializeContext>>,
  session: HarnessSession,
): HarnessSession {
  const next = ctx.get(ContinuationTokenKey);
  if (next === undefined || next === session.continuationToken) return session;
  return { ...session, continuationToken: next };
}

/**
 * Resolves the single output schema in effect for this turn, decoupling schema
 * enforcement from {@link RunMode}: downstream the harness reads
 * `session.outputSchema` unconditionally and never re-derives it from mode.
 *
 * A run-scoped (client-supplied) schema on the turn's {@link StepInput} always
 * wins. With no run-scoped schema, a task run adopts the agent's declared
 * return schema — its function-output contract, which only applies when the
 * agent is invoked as a function (subagent / schedule / job), i.e. task mode.
 * A conversation run with no run-scoped schema enforces nothing. Continuation
 * steps (no new `StepInput`) preserve whatever is already in effect.
 */
export function resolveEffectiveOutputSchema(input: {
  readonly agentOutputSchema: JsonObject | undefined;
  readonly input: StepInput | undefined;
  readonly mode: RunMode;
  readonly session: HarnessSession;
}): HarnessSession {
  const { agentOutputSchema, input: stepInput, mode, session } = input;

  if (stepInput?.outputSchema !== undefined) {
    return { ...session, outputSchema: stepInput.outputSchema };
  }

  if (mode === "task" && session.outputSchema === undefined && agentOutputSchema !== undefined) {
    return { ...session, outputSchema: agentOutputSchema };
  }

  return session;
}
