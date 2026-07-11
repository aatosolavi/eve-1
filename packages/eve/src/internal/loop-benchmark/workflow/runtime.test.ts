import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { RunInput } from "#channel/types.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

import { createWorkflowBenchmarkRuntime } from "./runtime.js";
import { workflowBenchmarkSession } from "./workflows.js";

const mocks = vi.hoisted(() => ({
  buildRunContext: vi.fn(),
  createLoopBenchmarkRecorder: vi.fn(),
  getCompiledRuntimeAgentBundle: vi.fn(),
  getRun: vi.fn(),
  recordLoopBenchmarkInterval: vi.fn(
    async (_recorder: unknown, _name: string, run: () => Promise<unknown>) => await run(),
  ),
  resumeHook: vi.fn(),
  scheduleLoopBenchmarkRecorderFlush: vi.fn(),
  serializeContext: vi.fn(),
  start: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getRun: mocks.getRun,
  resumeHook: mocks.resumeHook,
  start: mocks.start,
}));

vi.mock("#context/serialize.js", () => ({ serializeContext: mocks.serializeContext }));
vi.mock("#execution/runtime-context.js", () => ({ buildRunContext: mocks.buildRunContext }));
vi.mock("#internal/loop-benchmark/runtime-telemetry.js", () => ({
  createLoopBenchmarkRecorder: mocks.createLoopBenchmarkRecorder,
  recordLoopBenchmarkInterval: mocks.recordLoopBenchmarkInterval,
  scheduleLoopBenchmarkRecorderFlush: mocks.scheduleLoopBenchmarkRecorderFlush,
}));
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: mocks.getCompiledRuntimeAgentBundle,
}));

const SOURCE = createBundledRuntimeCompiledArtifactsSource();
const ADAPTER: ChannelAdapter = { kind: "http", state: {} };
const RECORDER = { engine: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createLoopBenchmarkRecorder.mockReturnValue(RECORDER);
  mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({ bundle: true });
  mocks.buildRunContext.mockReturnValue({ context: true });
  mocks.serializeContext.mockReturnValue({ serialized: true });
  mocks.start.mockResolvedValue({ runId: "workflow-benchmark-run" });
  mocks.getRun.mockReturnValue({
    getReadable: () => new ReadableStream<Uint8Array>(),
  });
});

describe("createWorkflowBenchmarkRuntime", () => {
  it("starts the benchmark-owned pinned session Workflow", async () => {
    const runtime = createWorkflowBenchmarkRuntime({ compiledArtifactsSource: SOURCE });

    await expect(
      runtime.run({
        adapter: ADAPTER,
        auth: null,
        continuationToken: "benchmark-token",
        input: { message: "hello" },
        mode: "conversation",
        requestId: "sample-workflow",
      }),
    ).resolves.toMatchObject({
      continuationToken: "benchmark-token",
      sessionId: "workflow-benchmark-run",
    });

    expect(mocks.buildRunContext).toHaveBeenCalledWith({
      bundle: { bundle: true },
      run: expect.objectContaining({ continuationToken: "benchmark-token" }),
    });
    expect(mocks.start).toHaveBeenCalledWith(workflowBenchmarkSession, [
      {
        compiledArtifactsSource: SOURCE,
        continuationToken: "benchmark-token",
        initialDelivery: {
          kind: "deliver",
          payloads: [{ message: "hello" }],
          requestId: "sample-workflow",
        },
        nodeId: undefined,
        sampleId: "sample-workflow",
        serializedContext: { serialized: true },
      },
    ]);
    expect(mocks.recordLoopBenchmarkInterval).toHaveBeenCalledWith(
      RECORDER,
      "engine.dispatch",
      expect.any(Function),
    );
    expect(RECORDER.engine).toHaveBeenCalledWith({
      kind: "workflow.run",
      workflowRunId: "workflow-benchmark-run",
    });
  });

  it.each([
    { input: { message: "hello" }, mode: "task", reason: "conversation" },
    {
      input: { context: ["hidden"], message: "hello" },
      mode: "conversation",
      reason: "context or output schemas",
    },
  ] satisfies readonly {
    readonly input: RunInput["input"];
    readonly mode: RunInput["mode"];
    readonly reason: string;
  }[])("rejects unsupported fixed-workload input: $reason", async ({ input, mode, reason }) => {
    const runtime = createWorkflowBenchmarkRuntime({ compiledArtifactsSource: SOURCE });

    await expect(
      runtime.run({
        adapter: ADAPTER,
        auth: null,
        input,
        mode,
      }),
    ).rejects.toThrow(reason);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("delivers through the benchmark session's Workflow Hook", async () => {
    mocks.resumeHook.mockResolvedValue({ runId: "workflow-benchmark-run" });
    const runtime = createWorkflowBenchmarkRuntime({ compiledArtifactsSource: SOURCE });

    await expect(
      runtime.deliver({
        auth: null,
        continuationToken: "benchmark-token",
        payload: { message: "again" },
        requestId: "sample-deliver",
      }),
    ).resolves.toEqual({ sessionId: "workflow-benchmark-run" });

    expect(mocks.resumeHook).toHaveBeenCalledWith("benchmark-token", {
      auth: null,
      kind: "deliver",
      payloads: [{ message: "again" }],
      requestId: "sample-deliver",
    });
  });

  it("normalizes a missing benchmark Hook", async () => {
    mocks.resumeHook.mockRejectedValue(new HookNotFoundError("missing-token"));
    const runtime = createWorkflowBenchmarkRuntime({ compiledArtifactsSource: SOURCE });

    await expect(
      runtime.deliver({
        continuationToken: "missing-token",
        payload: { message: "again" },
      }),
    ).rejects.toSatisfy(isRuntimeNoActiveSessionError);
  });
});
