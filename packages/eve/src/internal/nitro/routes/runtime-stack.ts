import type { Runtime } from "#channel/types.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { readSelectedLoop } from "#internal/loops/config.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  getRuntimeCompiledArtifactsCacheKey,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";

const TEMPORAL_LOOP_RUNTIME_GLOBAL_KEY = Symbol.for("eve.loops.temporal-runtime");

interface TemporalLoopRuntimeCache {
  readonly runtime: Promise<Runtime>;
  readonly sourceKey: string;
}

/**
 * Bundle returned to the per-channel Nitro dispatch handler.
 *
 * Carries the resolved channel set (framework defaults + authored
 * overrides minus authored disables) and the selected runtime.
 * The dispatch handler walks `channels` to match the inbound request
 * against a registered URL pattern, then calls the matched channel's
 * `fetch` with a `RouteContext` built from `runtime`.
 */
export interface NitroChannelRuntimeBundle {
  readonly channels: readonly ResolvedChannelDefinition[];
  readonly runtime: Runtime;
}

/**
 * Resolves the per-request channel bundle: the agent's resolved channels
 * (already merged with framework defaults by `resolve-agent-graph.ts`)
 * and the selected runtime. With no loop selection, this remains the
 * existing per-request Workflow runtime.
 *
 * The local Temporal loop runtime owns one process-wide server and Worker.
 */
export async function resolveNitroChannelRuntimeBundle(
  config: NitroArtifactsConfig,
): Promise<NitroChannelRuntimeBundle> {
  const compiledArtifactsSource = resolveNitroCompiledArtifactsSource(config);
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource,
  });
  const runtime = await resolveSelectedRuntime(compiledArtifactsSource);
  return {
    channels: bundle.graph.root.channels,
    runtime,
  };
}

async function resolveSelectedRuntime(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<Runtime> {
  const selected = readSelectedLoop();
  if (selected === undefined) {
    return createWorkflowRuntime({ compiledArtifactsSource });
  }

  if (selected === "workflow") {
    const { createWorkflowLoopRuntime } = await import("#internal/loops/workflow/runtime.js");
    return createWorkflowLoopRuntime({ compiledArtifactsSource });
  }

  if (selected === "inline") {
    if (process.env.VERCEL_ENV !== undefined) {
      throw new Error(
        'EVE_LOOP="inline" cannot run in a Vercel Function because its session and event stores are process-local.',
      );
    }
    const { createInlineLoopRuntime } = await import("#internal/loops/inline/runtime.js");
    return createInlineLoopRuntime({ compiledArtifactsSource });
  }

  if (process.env.VERCEL_ENV !== undefined) {
    throw new Error(
      'EVE_LOOP="temporal" is local-only. A Vercel Function cannot host the required long-lived Temporal Worker.',
    );
  }

  return await getTemporalLoopRuntime(compiledArtifactsSource);
}

async function getTemporalLoopRuntime(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<Runtime> {
  const sourceKey = getRuntimeCompiledArtifactsCacheKey(compiledArtifactsSource);
  const existing = readTemporalRuntimeCache();
  if (existing !== null) {
    if (existing.sourceKey === sourceKey) {
      return await existing.runtime;
    }
    // A new compiled-artifact snapshot (a dev-server recompile) retired the
    // cached runtime. Its Worker polls a runtime-unique task queue, so the
    // replacement cannot receive work routed to the retired instance; the
    // retired one shuts down in the background.
    Reflect.deleteProperty(globalThis, TEMPORAL_LOOP_RUNTIME_GLOBAL_KEY);
    void closeRetiredTemporalRuntime(existing.runtime);
  }

  const runtime = createLocalTemporalRuntime(compiledArtifactsSource);
  const cache: TemporalLoopRuntimeCache = { runtime, sourceKey };
  Reflect.set(globalThis, TEMPORAL_LOOP_RUNTIME_GLOBAL_KEY, cache);
  void runtime.catch(() => {
    if (readTemporalRuntimeCache()?.runtime === runtime) {
      Reflect.deleteProperty(globalThis, TEMPORAL_LOOP_RUNTIME_GLOBAL_KEY);
    }
  });
  return await runtime;
}

async function closeRetiredTemporalRuntime(runtime: Promise<Runtime>): Promise<void> {
  try {
    const retired: unknown = await runtime;
    if (isRecord(retired) && typeof retired["close"] === "function") {
      await (retired as { close(): Promise<void> }).close();
    }
  } catch {
    // The retired runtime failed to start or to shut down; the replacement
    // runtime does not depend on either outcome.
  }
}

async function createLocalTemporalRuntime(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<Runtime> {
  const { createTemporalLoopRuntime } = await import("#internal/loops/temporal/runtime.js");
  return await createTemporalLoopRuntime({ compiledArtifactsSource });
}

function readTemporalRuntimeCache(): TemporalLoopRuntimeCache | null {
  const value: unknown = Reflect.get(globalThis, TEMPORAL_LOOP_RUNTIME_GLOBAL_KEY);
  if (!isRecord(value)) return null;
  if (typeof value["sourceKey"] !== "string" || !(value["runtime"] instanceof Promise)) {
    return null;
  }
  return {
    runtime: value["runtime"],
    sourceKey: value["sourceKey"],
  };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}
