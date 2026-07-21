import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { RunInput } from "#channel/types.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

import { createWorkflowLoopRuntime } from "./runtime.js";

const mocks = vi.hoisted(() => ({
  buildRunContext: vi.fn(),
  getCompiledRuntimeAgentBundle: vi.fn(),
  getRun: vi.fn(),
  resumeHook: vi.fn(),
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
vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: mocks.getCompiledRuntimeAgentBundle,
}));

const SOURCE = createBundledRuntimeCompiledArtifactsSource();
const ADAPTER: ChannelAdapter = { kind: "http", state: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCompiledRuntimeAgentBundle.mockResolvedValue({ bundle: true });
  mocks.buildRunContext.mockReturnValue({ context: true });
  mocks.serializeContext.mockReturnValue({ serialized: true });
  mocks.start.mockResolvedValue({ runId: "workflow-loop-run" });
  mocks.getRun.mockReturnValue({
    getReadable: () => new ReadableStream<Uint8Array>(),
  });
});

describe("createWorkflowLoopRuntime", () => {
  it("starts the loop-owned pinned session through its bundled Workflow reference", async () => {
    const runtime = createWorkflowLoopRuntime({ compiledArtifactsSource: SOURCE });

    await expect(
      runtime.run({
        adapter: ADAPTER,
        auth: null,
        continuationToken: "loop-token",
        input: { message: "hello" },
        mode: "conversation",
        requestId: "sample-workflow",
      }),
    ).resolves.toMatchObject({
      continuationToken: "loop-token",
      sessionId: "workflow-loop-run",
    });

    expect(mocks.buildRunContext).toHaveBeenCalledWith({
      bundle: { bundle: true },
      run: expect.objectContaining({ continuationToken: "loop-token" }),
    });
    const packageInfo = resolveInstalledPackageInfo();
    expect(mocks.start).toHaveBeenCalledWith(
      {
        workflowId: `workflow//${packageInfo.name}@${packageInfo.version}//workflowLoopSession`,
      },
      [
        {
          compiledArtifactsSource: SOURCE,
          continuationToken: "loop-token",
          initialDelivery: {
            kind: "deliver",
            payloads: [{ message: "hello" }],
            requestId: "sample-workflow",
          },
          nodeId: undefined,
          serializedContext: { serialized: true },
        },
      ],
    );
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
    const runtime = createWorkflowLoopRuntime({ compiledArtifactsSource: SOURCE });

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

  it("delivers through the loop session's Workflow Hook", async () => {
    mocks.resumeHook.mockResolvedValue({ runId: "workflow-loop-run" });
    const runtime = createWorkflowLoopRuntime({ compiledArtifactsSource: SOURCE });

    await expect(
      runtime.deliver({
        auth: null,
        continuationToken: "loop-token",
        payload: { message: "again" },
        requestId: "sample-deliver",
      }),
    ).resolves.toEqual({ sessionId: "workflow-loop-run" });

    expect(mocks.resumeHook).toHaveBeenCalledWith("loop-token", {
      auth: null,
      kind: "deliver",
      payloads: [{ message: "again" }],
      requestId: "sample-deliver",
    });
  });

  it("normalizes a missing loop Hook for a channel-shaped plain-text payload", async () => {
    mocks.resumeHook.mockRejectedValue(new HookNotFoundError("missing-token"));
    const runtime = createWorkflowLoopRuntime({ compiledArtifactsSource: SOURCE });

    await expect(
      runtime.deliver({
        continuationToken: "missing-token",
        payload: {
          context: undefined,
          inputResponses: undefined,
          message: "again",
          outputSchema: undefined,
        },
      }),
    ).rejects.toSatisfy(isRuntimeNoActiveSessionError);
  });
});
