import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, defaultDeliverResult } from "#channel/adapter.js";
import type { DeliverPayload, HookPayload } from "#channel/types.js";
import { runStepEntrypoint, type EntryFlowTypes, type EntryPorts } from "#core/entrypoint.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { AuthKey, CapabilitiesKey, ModeKey } from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { runStep } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { isTurnCancellation, throwIfTurnAborted } from "#harness/turn-cancellation.js";
import { setChannelContext } from "#execution/channel-context.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import { classifyParkedSession } from "#harness/step-result.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { getTurnUsageState, toUsage } from "#harness/turn-tag-state.js";
import type { JsonObject } from "#shared/json.js";
import type { TokenUsage } from "#shared/token-usage.js";
import {
  createAuthorizationCompletedEvent,
  encodeMessageStreamEvent,
  type HandleMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#protocol/message.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
  type AuthorizationResult,
} from "#harness/authorization.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { AuthorizationCallback } from "#runtime/connections/types.js";
import {
  createDurableSessionState,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { createNodeGenerate, type CreateRuntime } from "#execution/node-generate.js";
import { recordSubagentUsageSpans } from "#execution/subagent-usage-span.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { hydrateDurableSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import type { EveAttributeWriter } from "#runtime/attributes/normalize.js";
import type { TurnStepResult } from "#internal/loops/types.js";

/**
 * Inputs for one harness step, with every engine-owned capability injected:
 * the pre-read durable session, the resolved callback base URL, the runtime
 * constructor for delegated child runs, and the observability attribute
 * writer. The operation itself never touches a Workflow primitive.
 */
export interface TurnStepOperationInput {
  /** Cancellation signal forwarded into the step. */
  readonly abortSignal?: AbortSignal;
  /** Callback base URL for tool-execution hooks, when the host knows one. */
  readonly callbackBaseUrl: string | undefined;
  /** Runtime constructor used to start delegated child runs. */
  readonly createRuntime: CreateRuntime;
  /** The durable session, pre-read by the host from `sessionState`. */
  readonly durableSession: DurableSession;
  readonly input: HookPayload | undefined;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  /** Attribute sink, or `undefined` when the host has no attribute store. */
  readonly writeEveAttributes: EveAttributeWriter | undefined;
}

/** The eve binding of the entrypoint's opaque slots. */
interface EveEntryFlow extends EntryFlowTypes {
  readonly authCallback: {
    readonly callback: AuthorizationCallback;
    readonly connectionName: string;
  };
  readonly authCompletion: {
    readonly authorization: ConnectionAuthorizationChallenge;
    readonly name: string;
  };
  readonly context: Awaited<ReturnType<typeof deserializeContext>>;
  readonly deliveryPayload: DeliverPayload;
  readonly durableSession: DurableSession;
  readonly durableState: DurableSessionState;
  readonly emissionState: ReturnType<typeof getHarnessEmissionState>;
  readonly event: HandleMessageStreamEvent;
  readonly messages: readonly import("ai").ModelMessage[];
  readonly outputSchema: JsonObject;
  readonly pendingAuthorization: NonNullable<ReturnType<typeof getPendingAuthorization>>;
  readonly serializedContext: Record<string, unknown>;
  readonly session: HarnessSession;
  readonly stepInput: StepInput;
  readonly turnInput: HookPayload;
  readonly usage: TokenUsage;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}

/**
 * Runs one atomic harness step: fold the delivery in, run the model with
 * its tools, and return the classified {@link TurnStepResult} projected
 * onto the serialized session cursors.
 *
 * Engine-neutral by construction — the caller owns the durable boundary
 * (e.g. a Workflow `"use step"`), session reading, and retry policy. The
 * flow itself is the core
 * {@link import("#core/entrypoint.js").runStepEntrypoint} program; this
 * module only binds its dependencies to the eve runtime.
 */
export async function executeTurnStepOperation(
  input: TurnStepOperationInput,
): Promise<TurnStepResult> {
  return await runStepEntrypoint(createEntryPorts(input), {
    callbackBaseUrl: input.callbackBaseUrl,
    durableSession: input.durableSession,
    durableSnapshot: input.sessionState,
    serializedContext: input.serializedContext,
    turnInput: input.input,
  });
}

function createEntryPorts(input: TurnStepOperationInput): EntryPorts<EveEntryFlow> {
  type Ctx = EveEntryFlow["context"];
  type Channel = {
    readonly adapter: Parameters<typeof callAdapterEventHandler>[0];
    readonly adapterCtx: ReturnType<typeof buildAdapterContext>;
  };

  // The adapter context is shared across every deliver and event-transform
  // call of one step so adapter-state mutations accumulate before being
  // pinned back onto the runtime context.
  let channel: Channel | undefined;
  const channelFor = (ctx: Ctx): Channel => {
    if (channel === undefined) {
      const adapter = ctx.require(ChannelKey);
      channel = { adapter, adapterCtx: buildAdapterContext(adapter, ctx) };
    }
    return channel;
  };

  return {
    auth: {
      callbackOf: (payload) =>
        payload["authorizationCallback"] as EveEntryFlow["authCallback"] | undefined,

      clearPending: (durable, names) => ({
        ...durable,
        state: clearPendingAuthorization(durable.state, names),
      }),

      completedEvent: ({ completion, emissionState }) =>
        createAuthorizationCompletedEvent({
          authorization: completion.authorization,
          name: completion.name,
          outcome: "authorized",
          sequence: emissionState.sequence,
          stepIndex: emissionState.stepIndex,
          turnId: emissionState.turnId,
        }),

      match(pending, callback) {
        const challenge = pending.challenges.find((c) => c.name === callback.connectionName);
        if (challenge === undefined) {
          return undefined;
        }
        const result: { name: string } & AuthorizationResult = {
          callback: callback.callback,
          hookUrl: challenge.hookUrl,
          name: challenge.name,
          resume: challenge.resume,
        };
        return {
          completion: { authorization: challenge.challenge, name: challenge.name },
          name: challenge.name,
          result,
        };
      },

      pendingOf: (durable) => getPendingAuthorization(durable.state),

      stash(ctx, results) {
        ctx.set(
          PendingAuthorizationResultKey,
          results as Array<{ name: string } & AuthorizationResult>,
        );
      },
    },

    cancellation: {
      assertNotAborted: () => throwIfTurnAborted(input.abortSignal),
      isCancellation: (error) => isTurnCancellation(error),
    },

    channel: {
      coalesce: (first, second) => coalesceTurnInputs(first, second),

      async deliver(ctx, payload) {
        const { adapter, adapterCtx } = channelFor(ctx);
        const result = adapter.deliver
          ? await adapter.deliver(payload, adapterCtx)
          : defaultDeliverResult(payload);
        return result ?? undefined;
      },

      pinAdapterState(ctx) {
        const { adapter, adapterCtx } = channelFor(ctx);
        setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
      },

      async transformEvent(ctx, event) {
        const { adapter, adapterCtx } = channelFor(ctx);
        const toEmit = await callAdapterEventHandler(adapter, event, adapterCtx);
        setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
        return toEmit;
      },
    },

    codec: {
      restore: (serialized) => deserializeContext(serialized),
      serialize: (ctx) => serializeContext(ctx),
    },

    contexts: {
      applyDeliveryAuth(ctx, turnInput) {
        if (turnInput?.kind === "deliver" && turnInput.auth !== undefined) {
          ctx.set(AuthKey, turnInput.auth ?? null);
        }
      },
      modeOf: (ctx) => ctx.require(ModeKey),
      seedCallbackBaseUrl: (ctx, url) => ctx.set(CallbackBaseUrlKey, url),
    },

    async generate({ ctx, handleEvent, input: stepInput, session }) {
      const bundle = ctx.require(BundleKey);
      const step = createNodeGenerate({
        abortSignal: input.abortSignal,
        capabilities: ctx.get(CapabilitiesKey),
        createRuntime: input.createRuntime,
        handleEvent,
        mode: ctx.require(ModeKey),
        modelResolutionScope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
        node: bundle.graph.root,
        workflowMaxSubagents: session.workflowMaxSubagents,
        writeEveAttributes: input.writeEveAttributes,
      });
      return await step(session, stepInput);
    },

    hooks: {
      dispatchDynamicInstructions: (ctx, event, messages) =>
        dispatchDynamicInstructionEvent({
          ctx,
          event,
          messages: messages ?? [],
          resolvers: ctx.require(BundleKey).resolvedAgent.dynamicInstructionsResolvers ?? [],
        }),

      dispatchDynamicModel(ctx, event, messages) {
        const bundle = ctx.require(BundleKey);
        return dispatchDynamicModelEvent({
          ctx,
          dynamicModel: bundle.turnAgent.dynamicModel,
          event,
          fallback: bundle.turnAgent.model,
          messages: messages ?? [],
          scope: { moduleMap: bundle.moduleMap, nodeId: bundle.nodeId },
        });
      },

      dispatchDynamicSkills: (ctx, event, messages) =>
        dispatchDynamicSkillEvent({
          ctx,
          event,
          messages: messages ?? [],
          resolvers: ctx.require(BundleKey).resolvedAgent.dynamicSkillResolvers ?? [],
        }),

      dispatchDynamicTools: (ctx, event, messages) =>
        dispatchDynamicToolEvent({
          ctx,
          event,
          messages: messages ?? [],
          resolvers: ctx.require(BundleKey).resolvedAgent.dynamicToolResolvers ?? [],
        }),

      dispatchStreamHooks: (ctx, event) =>
        dispatchStreamEventHooks({ ctx, event, registry: ctx.require(BundleKey).hookRegistry }),

      isStepStarted: (event) => event.type === "step.started",
    },

    schema: {
      agentSchemaOf: (ctx) => ctx.require(BundleKey).turnAgent.outputSchema,
      hasSchema: (session) => session.outputSchema !== undefined,
      runScopedOf: (stepInput) => stepInput?.outputSchema,
      withSchema: (session, schema) => ({ ...session, outputSchema: schema }),
    },

    scope: {
      run: (ctx, session, fn) => runStep(ctx, session, fn),
    },

    sessions: {
      classifyParked: (session) => classifyParkedSession(session),

      hydrate: (ctx, durable) =>
        hydrateDurableSession({
          compactionOverrides: {
            thresholdPercent:
              ctx.require(BundleKey).resolvedAgent.config.compaction?.thresholdPercent,
          },
          durable,
          turnAgent: ctx.require(BundleKey).turnAgent,
        }),

      readEmission: (session) => getHarnessEmissionState(session.state),

      reconcileToken: (ctx, session) => reconcileSessionContinuationToken(ctx, session),

      refresh: (ctx, session) =>
        refreshSessionFromTurnAgent({
          compactionOverrides: {
            thresholdPercent:
              ctx.require(BundleKey).resolvedAgent.config.compaction?.thresholdPercent,
          },
          session,
          turnAgent: ctx.require(BundleKey).turnAgent,
        }),

      snapshot: (session) => createDurableSessionState({ session }),
    },

    stream: {
      close: (writer) => writer.close(),
      open: () => input.parentWritable.getWriter(),
      release: (writer) => writer.releaseLock(),
      write: (writer, event) =>
        writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(event))),
    },

    turnInputs: {
      asChildResultInput: (turnInput) => ({
        runtimeActionResults: turnInput.kind === "runtime-action-result" ? turnInput.results : [],
      }),
      isChildResults: (turnInput) => turnInput?.kind === "runtime-action-result",
      isDelivery: (turnInput) => turnInput?.kind === "deliver",
      payloadsOf: (turnInput) => (turnInput.kind === "deliver" ? turnInput.payloads : []),
      withPayloads: (turnInput, payloads) =>
        turnInput.kind === "deliver" ? { ...turnInput, payloads: [...payloads] } : turnInput,
    },

    usage: {
      recordChildSpans(turnInput) {
        if (turnInput.kind === "runtime-action-result") {
          recordSubagentUsageSpans(turnInput.results);
        }
      },
      sessionTotalsOf(session) {
        const totals = getTurnUsageState(session.state)?.session;
        return totals === undefined ? undefined : toUsage(totals);
      },
    },
  };
}
