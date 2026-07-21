import { afterEach, describe, expect, it, vi } from "vitest";

import type { Runtime } from "#channel/types.js";
import { resolveNitroChannelRuntimeBundle } from "#internal/nitro/routes/runtime-stack.js";
import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";

const mocks = vi.hoisted(() => ({
  createInlineLoopRuntime: vi.fn(),
  createTemporalLoopRuntime: vi.fn(),
  createWorkflowLoopRuntime: vi.fn(),
  createWorkflowRuntime: vi.fn(),
  getCompiledRuntimeAgentBundle: vi.fn(),
  resolveNitroCompiledArtifactsSource: vi.fn(),
}));

vi.mock("#execution/workflow-runtime.js", () => ({
  createWorkflowRuntime: mocks.createWorkflowRuntime,
}));

vi.mock("#internal/loops/inline/runtime.js", () => ({
  createInlineLoopRuntime: mocks.createInlineLoopRuntime,
}));

vi.mock("#internal/loops/temporal/runtime.js", () => ({
  createTemporalLoopRuntime: mocks.createTemporalLoopRuntime,
}));

vi.mock("#internal/loops/workflow/runtime.js", () => ({
  createWorkflowLoopRuntime: mocks.createWorkflowLoopRuntime,
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
const WORKFLOW_LOOP_RUNTIME = createRuntimeStub();
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
    expect(mocks.createWorkflowLoopRuntime).not.toHaveBeenCalled();
    expect(mocks.createInlineLoopRuntime).not.toHaveBeenCalled();
    expect(mocks.createTemporalLoopRuntime).not.toHaveBeenCalled();
  });

  it("selects the Workflow loop runtime in a Vercel Function", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP", "workflow");
    vi.stubEnv("VERCEL_ENV", "preview");

    await expect(resolveNitroChannelRuntimeBundle({})).resolves.toEqual({
      channels: CHANNELS,
      runtime: WORKFLOW_LOOP_RUNTIME,
    });

    expect(mocks.createWorkflowLoopRuntime).toHaveBeenCalledWith({
      compiledArtifactsSource: SOURCE,
    });
    expect(mocks.createWorkflowRuntime).not.toHaveBeenCalled();
    expect(mocks.createInlineLoopRuntime).not.toHaveBeenCalled();
    expect(mocks.createTemporalLoopRuntime).not.toHaveBeenCalled();
  });

  it("selects the inline loop runtime", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP", "inline");

    await expect(resolveNitroChannelRuntimeBundle({})).resolves.toEqual({
      channels: CHANNELS,
      runtime: INLINE_RUNTIME,
    });

    expect(mocks.createInlineLoopRuntime).toHaveBeenCalledWith({
      compiledArtifactsSource: SOURCE,
    });
    expect(mocks.createWorkflowRuntime).not.toHaveBeenCalled();
  });

  it("rejects the process-local inline topology in a Vercel Function", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP", "inline");
    vi.stubEnv("VERCEL_ENV", "preview");

    await expect(resolveNitroChannelRuntimeBundle({})).rejects.toThrow(
      "session and event stores are process-local",
    );
    expect(mocks.createInlineLoopRuntime).not.toHaveBeenCalled();
  });

  it("reuses one process-global local Temporal runtime", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP", "temporal");

    const [first, second] = await Promise.all([
      resolveNitroChannelRuntimeBundle({}),
      resolveNitroChannelRuntimeBundle({}),
    ]);

    expect(first.runtime).toBe(TEMPORAL_RUNTIME);
    expect(second.runtime).toBe(TEMPORAL_RUNTIME);

    expect(mocks.createTemporalLoopRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.createTemporalLoopRuntime).toHaveBeenCalledWith({
      compiledArtifactsSource: SOURCE,
    });
  });

  it("replaces the local Temporal runtime when the compiled artifact source changes", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP", "temporal");

    const close = vi.fn(async () => {});
    const retired = { ...createRuntimeStub(), close };
    const original = createDiskRuntimeCompiledArtifactsSource("/tmp/original-app");
    mocks.resolveNitroCompiledArtifactsSource.mockReturnValue(original);
    mocks.createTemporalLoopRuntime.mockResolvedValueOnce(retired);
    const first = await resolveNitroChannelRuntimeBundle({});
    expect(first.runtime).toBe(retired);

    const replacement = createRuntimeStub();
    mocks.createTemporalLoopRuntime.mockResolvedValueOnce(replacement);
    const recompiled = createDiskRuntimeCompiledArtifactsSource("/tmp/recompiled-app");
    mocks.resolveNitroCompiledArtifactsSource.mockReturnValue(recompiled);

    const second = await resolveNitroChannelRuntimeBundle({});

    expect(second.runtime).toBe(replacement);
    expect(mocks.createTemporalLoopRuntime).toHaveBeenLastCalledWith({
      compiledArtifactsSource: recompiled,
    });
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects the local Temporal Worker topology on Vercel", async () => {
    prepare();
    vi.stubEnv("EVE_LOOP", "temporal");
    vi.stubEnv("VERCEL_ENV", "preview");

    await expect(resolveNitroChannelRuntimeBundle({})).rejects.toThrow(
      "A Vercel Function cannot host the required long-lived Temporal Worker",
    );
    expect(mocks.createTemporalLoopRuntime).not.toHaveBeenCalled();
  });
});

function prepare(): void {
  vi.stubEnv("EVE_LOOP", undefined);
  vi.stubEnv("VERCEL_ENV", undefined);
  mocks.resolveNitroCompiledArtifactsSource.mockReturnValue(SOURCE);
  mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({
    graph: { root: { channels: CHANNELS } },
  });
  mocks.createWorkflowRuntime.mockReturnValue(PRODUCTION_WORKFLOW_RUNTIME);
  mocks.createWorkflowLoopRuntime.mockReturnValue(WORKFLOW_LOOP_RUNTIME);
  mocks.createInlineLoopRuntime.mockReturnValue(INLINE_RUNTIME);
  mocks.createTemporalLoopRuntime.mockResolvedValue(TEMPORAL_RUNTIME);
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
