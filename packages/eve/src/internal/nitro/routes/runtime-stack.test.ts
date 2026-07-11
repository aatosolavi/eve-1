import { afterEach, describe, expect, it, vi } from "vitest";

import type { Runtime } from "#channel/types.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const mocks = vi.hoisted(() => ({
  createInlineBenchmarkRuntime: vi.fn(),
  createLocalTemporalBenchmarkRuntime: vi.fn(),
  createWorkflowBenchmarkRuntime: vi.fn(),
  createWorkflowRuntime: vi.fn(),
  getCompiledRuntimeAgentBundle: vi.fn(),
  resolveNitroCompiledArtifactsSource: vi.fn(),
}));

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: mocks.createWorkflowRuntime,
}));

vi.mock("#internal/loop-benchmark/inline/runtime.js", () => ({
  createInlineBenchmarkRuntime: mocks.createInlineBenchmarkRuntime,
}));

vi.mock("#internal/loop-benchmark/temporal/runtime.js", () => ({
  createLocalTemporalBenchmarkRuntime: mocks.createLocalTemporalBenchmarkRuntime,
}));

vi.mock("#internal/loop-benchmark/workflow/runtime.js", () => ({
  createWorkflowBenchmarkRuntime: mocks.createWorkflowBenchmarkRuntime,
}));

vi.mock("#internal/nitro/routes/runtime-artifacts.js", () => ({
  resolveNitroCompiledArtifactsSource: mocks.resolveNitroCompiledArtifactsSource,
}));

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: mocks.getCompiledRuntimeAgentBundle,
}));

const SOURCE = createBundledRuntimeCompiledArtifactsSource();
const CHANNELS: readonly [] = [];
const PRODUCTION_WORKFLOW_RUNTIME = createRuntimeStub();
const WORKFLOW_BENCHMARK_RUNTIME = createRuntimeStub();
const INLINE_RUNTIME = createRuntimeStub();
const TEMPORAL_RUNTIME = createRuntimeStub();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("resolveNitroChannelRuntimeBundle", () => {
  it("keeps the production Workflow runtime as the default", async () => {
    prepare();

    await expect(resolveNitroChannelRuntimeBundle({})).resolves.toEqual({
      channels: CHANNELS,
      runtime: PRODUCTION_WORKFLOW_RUNTIME,
    });

    expect(mocks.createWorkflowRuntime).toHaveBeenCalledWith({
      compiledArtifactsSource: SOURCE,
    });
    expect(mocks.createWorkflowBenchmarkRuntime).not.toHaveBeenCalled();
    expect(mocks.createInlineBenchmarkRuntime).not.toHaveBeenCalled();
    expect(mocks.createLocalTemporalBenchmarkRuntime).not.toHaveBeenCalled();
  });

  it("selects the Workflow benchmark runtime in a Vercel Function", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP_BENCHMARK_RUNTIME", "workflow");
    vi.stubEnv("VERCEL_ENV", "preview");

    await expect(resolveNitroChannelRuntimeBundle({})).resolves.toEqual({
      channels: CHANNELS,
      runtime: WORKFLOW_BENCHMARK_RUNTIME,
    });

    expect(mocks.createWorkflowBenchmarkRuntime).toHaveBeenCalledWith({
      compiledArtifactsSource: SOURCE,
    });
    expect(mocks.createWorkflowRuntime).not.toHaveBeenCalled();
    expect(mocks.createInlineBenchmarkRuntime).not.toHaveBeenCalled();
    expect(mocks.createLocalTemporalBenchmarkRuntime).not.toHaveBeenCalled();
  });

  it("selects the inline benchmark runtime", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP_BENCHMARK_RUNTIME", "inline");

    await expect(resolveNitroChannelRuntimeBundle({})).resolves.toEqual({
      channels: CHANNELS,
      runtime: INLINE_RUNTIME,
    });

    expect(mocks.createInlineBenchmarkRuntime).toHaveBeenCalledWith({
      compiledArtifactsSource: SOURCE,
    });
    expect(mocks.createWorkflowRuntime).not.toHaveBeenCalled();
  });

  it("rejects the process-local inline topology in a Vercel Function", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP_BENCHMARK_RUNTIME", "inline");
    vi.stubEnv("VERCEL_ENV", "preview");

    await expect(resolveNitroChannelRuntimeBundle({})).rejects.toThrow(
      "session and event stores are process-local",
    );
    expect(mocks.createInlineBenchmarkRuntime).not.toHaveBeenCalled();
  });

  it("reuses one process-global local Temporal runtime", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP_BENCHMARK_RUNTIME", "temporal");

    const [first, second] = await Promise.all([
      resolveNitroChannelRuntimeBundle({}),
      resolveNitroChannelRuntimeBundle({}),
    ]);

    expect(first.runtime).toBe(TEMPORAL_RUNTIME);
    expect(second.runtime).toBe(TEMPORAL_RUNTIME);

    expect(mocks.createLocalTemporalBenchmarkRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.createLocalTemporalBenchmarkRuntime).toHaveBeenCalledWith({
      compiledArtifactsSource: SOURCE,
    });
  });

  it("rejects the local Temporal Worker topology on Vercel", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP_BENCHMARK_RUNTIME", "temporal");
    vi.stubEnv("VERCEL_ENV", "preview");

    await expect(resolveNitroChannelRuntimeBundle({})).rejects.toThrow(
      "A Vercel Function cannot host the required long-lived Temporal Worker",
    );
    expect(mocks.createLocalTemporalBenchmarkRuntime).not.toHaveBeenCalled();
  });

  it("allows a Vercel-hosted Sandbox to label records without impersonating a Function", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP_BENCHMARK_RUNTIME", "temporal");
    vi.stubEnv("EVE_LOOP_BENCHMARK_TARGET", "vercel");

    await expect(resolveNitroChannelRuntimeBundle({})).resolves.toEqual({
      channels: CHANNELS,
      runtime: TEMPORAL_RUNTIME,
    });
  });
});

function prepare(): void {
  vi.stubEnv("EVE_LOOP_BENCHMARK_RUNTIME", undefined);
  vi.stubEnv("VERCEL_ENV", undefined);
  mocks.resolveNitroCompiledArtifactsSource.mockReturnValue(SOURCE);
  mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({
    graph: { root: { channels: CHANNELS } },
  });
  mocks.createWorkflowRuntime.mockReturnValue(PRODUCTION_WORKFLOW_RUNTIME);
  mocks.createWorkflowBenchmarkRuntime.mockReturnValue(WORKFLOW_BENCHMARK_RUNTIME);
  mocks.createInlineBenchmarkRuntime.mockReturnValue(INLINE_RUNTIME);
  mocks.createLocalTemporalBenchmarkRuntime.mockResolvedValue(TEMPORAL_RUNTIME);
}

function createRuntimeStub(): Runtime {
  return {
    async deliver() {
      return { sessionId: "unused" };
    },
    async getEventStream() {
      return new ReadableStream();
    },
    async run() {
      throw new Error("Runtime stub run() is not used by selector tests.");
    },
  };
}
