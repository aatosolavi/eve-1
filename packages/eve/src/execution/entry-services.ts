import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, defaultDeliverResult } from "#channel/adapter.js";
import type { EntryServices, StepEntryInput } from "#core/entrypoint.js";
import { CapabilitiesKey, ModeKey } from "#core/context/keys.js";
import {
  encodeMessageStreamEvent,
  timestampHandleMessageStreamEvent,
} from "#core/protocol/message.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { dispatchDynamicModelEvent } from "#context/dynamic-model-lifecycle.js";
import { dispatchDynamicSkillEvent } from "#context/dynamic-skill-lifecycle.js";
import { dispatchDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import { runStep } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { setChannelContext } from "#execution/channel-context.js";
import { createNodeGenerate, type CreateRuntime } from "#execution/node-generate.js";
import { hydrateDurableSession, refreshSessionFromTurnAgent } from "#execution/session.js";
import { recordSubagentUsageSpans } from "#execution/subagent-usage-span.js";
import type { EveAttributeWriter } from "#runtime/attributes/normalize.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

/** Host capabilities required to bind one entrypoint invocation. */
export interface EntryDependencies {
  readonly abortSignal?: AbortSignal;
  readonly createRuntime: CreateRuntime;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly writeEveAttributes: EveAttributeWriter | undefined;
}

/** The engine-supplied input type retained for loop callers. */
export type EveEntryInput = StepEntryInput;

/** Binds host effects to the concrete durable-step program. */
export function createEntryServices(input: EntryDependencies): EntryServices {
  type Ctx = Awaited<ReturnType<typeof deserializeContext>>;
  type Channel = {
    readonly adapter: Parameters<typeof callAdapterEventHandler>[0];
    readonly adapterCtx: ReturnType<typeof buildAdapterContext>;
  };

  let channel: Channel | undefined;
  const channelFor = (ctx: Ctx): Channel => {
    if (channel === undefined) {
      const adapter = ctx.require(ChannelKey);
      channel = { adapter, adapterCtx: buildAdapterContext(adapter, ctx) };
    }
    return channel;
  };

  return {
    cancellation: {
      abortSignal: input.abortSignal,
    },

    channel: {
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
      async restore(serialized) {
        const ctx = await deserializeContext(serialized);
        return {
          agentOutputSchema: ctx.require(BundleKey).turnAgent.outputSchema,
          ctx,
        };
      },
      serialize: (ctx) => serializeContext(ctx),
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

      recordChildUsageSpans: (results) => recordSubagentUsageSpans(results),
    },

    scope: {
      run: (ctx, session, fn) => runStep(ctx, session, fn),
    },

    sessions: {
      hydrate: (ctx, durable) =>
        hydrateDurableSession({
          compactionOverrides: {
            thresholdPercent:
              ctx.require(BundleKey).resolvedAgent.config.compaction?.thresholdPercent,
          },
          durable,
          turnAgent: ctx.require(BundleKey).turnAgent,
        }),

      refresh: (ctx, session) =>
        refreshSessionFromTurnAgent({
          compactionOverrides: {
            thresholdPercent:
              ctx.require(BundleKey).resolvedAgent.config.compaction?.thresholdPercent,
          },
          session,
          turnAgent: ctx.require(BundleKey).turnAgent,
        }),
    },

    stream: {
      close: (writer) => writer.close(),
      open: () => input.parentWritable.getWriter(),
      release: (writer) => writer.releaseLock(),
      write: (writer, event) =>
        writer.write(encodeMessageStreamEvent(timestampHandleMessageStreamEvent(event))),
    },
  };
}
