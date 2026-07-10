import type { Runtime } from "#channel/types.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { readLoopBenchmarkRuntime } from "#internal/loop-benchmark/config.js";
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

const TEMPORAL_BENCHMARK_RUNTIME_GLOBAL_KEY = Symbol.for("eve.loop-benchmark.temporal-runtime");

interface TemporalBenchmarkRuntimeCache {
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
 * and the selected runtime. With no benchmark override, this remains the
 * existing per-request Workflow runtime.
 *
 * The local Temporal benchmark owns one process-wide server and Worker.
 * Inline and Workflow state follow their existing runtime implementations.
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
  const selected = readLoopBenchmarkRuntime();
  if (selected === undefined || selected === "workflow") {
    return createWorkflowRuntime({ compiledArtifactsSource });
  }

  if (selected === "inline") {
    if (process.env.VERCEL_ENV !== undefined) {
      throw new Error(
        'EVE_LOOP_BENCHMARK_RUNTIME="inline" cannot run in a Vercel Function because its session and event stores are process-local.',
      );
    }
    const { createInlineBenchmarkRuntime } =
      await import("#internal/loop-benchmark/inline/runtime.js");
    return createInlineBenchmarkRuntime({ compiledArtifactsSource });
  }

  if (process.env.VERCEL_ENV !== undefined) {
    throw new Error(
      'EVE_LOOP_BENCHMARK_RUNTIME="temporal" is local-only. A Vercel Function cannot host the required long-lived Temporal Worker.',
    );
  }

  return await getLocalTemporalBenchmarkRuntime(compiledArtifactsSource);
}

async function getLocalTemporalBenchmarkRuntime(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<Runtime> {
  const sourceKey = getRuntimeCompiledArtifactsCacheKey(compiledArtifactsSource);
  const existing = readTemporalRuntimeCache();
  if (existing !== null) {
    if (existing.sourceKey !== sourceKey) {
      throw new Error(
        `Local Temporal benchmark runtime already uses compiled artifact source "${existing.sourceKey}"; received "${sourceKey}".`,
      );
    }
    return await existing.runtime;
  }

  const runtime = createLocalTemporalRuntime(compiledArtifactsSource);
  const cache: TemporalBenchmarkRuntimeCache = { runtime, sourceKey };
  Reflect.set(globalThis, TEMPORAL_BENCHMARK_RUNTIME_GLOBAL_KEY, cache);
  void runtime.catch(() => {
    if (readTemporalRuntimeCache()?.runtime === runtime) {
      Reflect.deleteProperty(globalThis, TEMPORAL_BENCHMARK_RUNTIME_GLOBAL_KEY);
    }
  });
  return await runtime;
}

async function createLocalTemporalRuntime(
  compiledArtifactsSource: RuntimeCompiledArtifactsSource,
): Promise<Runtime> {
  const { createLocalTemporalBenchmarkRuntime } =
    await import("#internal/loop-benchmark/temporal/runtime.js");
  return await createLocalTemporalBenchmarkRuntime({ compiledArtifactsSource });
}

function readTemporalRuntimeCache(): TemporalBenchmarkRuntimeCache | null {
  const value: unknown = Reflect.get(globalThis, TEMPORAL_BENCHMARK_RUNTIME_GLOBAL_KEY);
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
