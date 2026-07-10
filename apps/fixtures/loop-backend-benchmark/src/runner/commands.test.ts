import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runHostedBenchmarkCommand,
  runLocalBenchmarkCommand,
  runSandboxBenchmarkCommand,
  type LocalSetupRecord,
} from "./commands.js";
import { LocalRuntimeServerGroup } from "./local-servers.js";
import { runBenchmarkMatrix } from "./matrix.js";
import type { SandboxRuntimeServerGroupHandle, SandboxSetupRecord } from "./sandbox-servers.js";
import type { BenchmarkMatrixConfig, BenchmarkSummaryRecord } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runLocalBenchmarkCommand", () => {
  it("stops every local server after a successful matrix", async () => {
    const stop = vi.fn(async (_runtimeKind: string) => undefined);
    const records: LocalSetupRecord[] = [];
    const runMatrix = vi.fn(async (config: BenchmarkMatrixConfig) => summary(config));

    await runLocalBenchmarkCommand(
      {
        measuredBlocks: 2,
        modelKind: "deterministic",
        mode: "local",
        seed: 7,
        warmupBlocks: 1,
      },
      {
        createRunId: () => "run-local",
        runMatrix,
        serverGroup: fakeGroup(stop),
        writeRecord(record) {
          records.push(record);
        },
      },
    );

    expect(runMatrix).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-local", targetKind: "local" }),
      expect.objectContaining({ collectServerTelemetry: expect.any(Function) }),
    );
    expect(stop).toHaveBeenCalledTimes(3);
    expect(records).toEqual([
      {
        arch: process.arch,
        kind: "setup",
        modelKind: "deterministic",
        nodeVersion: process.version,
        platform: process.platform,
        runId: "run-local",
        runtimeUrls: {
          inline: "http://inline.example",
          temporal: "http://temporal.example",
          workflow: "http://workflow.example",
        },
        targetKind: "local",
        topology: "local-processes",
      },
    ]);
  });

  it("stops every local server when the matrix fails", async () => {
    const stop = vi.fn(async (_runtimeKind: string) => undefined);
    await expect(
      runLocalBenchmarkCommand(
        {
          measuredBlocks: 2,
          modelKind: "deterministic",
          mode: "local",
          seed: 7,
          warmupBlocks: 1,
        },
        {
          createRunId: () => "run-local",
          async runMatrix() {
            throw new Error("matrix failed");
          },
          serverGroup: fakeGroup(stop),
          writeRecord: vi.fn(),
        },
      ),
    ).rejects.toThrow("matrix failed");
    expect(stop).toHaveBeenCalledTimes(3);
  });
});

describe("runHostedBenchmarkCommand", () => {
  it("passes explicit Vercel URLs to the shared matrix runner", async () => {
    const runMatrix = vi.fn(async (config: BenchmarkMatrixConfig) => summary(config));
    await runHostedBenchmarkCommand(
      {
        measuredBlocks: 30,
        modelKind: "live",
        mode: "hosted",
        runtimeUrls: {
          inline: "https://inline.example",
          temporal: "https://temporal.example",
          workflow: "https://workflow.example",
        },
        seed: 1,
        warmupBlocks: 3,
      },
      { createRunId: () => "run-hosted", runMatrix },
    );

    expect(runMatrix).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-hosted", targetKind: "vercel" }),
    );
  });
});

describe("runSandboxBenchmarkCommand", () => {
  it("writes setup metadata before running the shared Vercel matrix", async () => {
    const callOrder: string[] = [];
    const records: SandboxSetupRecord[] = [];
    const requestHeaders: Headers[] = [];
    const requestRedirects: Array<"error" | "follow" | "manual" | undefined> = [];
    const stop = vi.fn(async () => undefined);
    const serverGroup = fakeSandboxGroup(stop);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        requestHeaders.push(new Headers(init?.headers));
        requestRedirects.push(init?.redirect);
        return init?.method === "POST"
          ? Response.json({ continuationToken: "next-token", sessionId: "session-01" })
          : new Response(
              `${JSON.stringify({ data: { wait: "next-user-message" }, type: "session.waiting" })}\n`,
              { headers: { "content-type": "application/x-ndjson; charset=utf-8" } },
            );
      }),
    );
    const runMatrix = vi.fn(
      async (
        config: BenchmarkMatrixConfig,
        overrides: Parameters<typeof runBenchmarkMatrix>[1],
      ) => {
        callOrder.push("matrix");
        await overrides?.runSample?.({
          nonce: "nonce-test",
          runtimeKind: "inline",
          sampleId: "sample-test",
          targetKind: "vercel",
          targetUrl: config.runtimeUrls.inline,
        });
        return summary(config);
      },
    );

    await runSandboxBenchmarkCommand(sandboxConfig(), {
      createRunId: () => "run-sandbox",
      runMatrix,
      serverGroup,
      writeRecord(record) {
        callOrder.push("setup");
        records.push(record);
      },
    });

    expect(callOrder).toEqual(["setup", "matrix"]);
    expect(records).toEqual([
      {
        gitRevision: "0123456789abcdef0123456789abcdef01234567",
        kind: "setup",
        modelKind: "live",
        runId: "run-sandbox",
        runtimeUrls: {
          inline: "https://inline.sandbox.example",
          temporal: "https://temporal.sandbox.example",
          workflow: "https://workflow.sandbox.example",
        },
        sandbox: {
          memoryMb: 8192,
          name: "benchmark-sandbox",
          region: "iad1",
          runtime: "node24",
          vcpus: 4,
        },
        targetKind: "vercel",
        topology: "vercel-sandbox",
      },
    ]);
    expect(runMatrix).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-sandbox", targetKind: "vercel" }),
      expect.objectContaining({
        collectServerTelemetry: expect.any(Function),
        runSample: expect.any(Function),
      }),
    );
    expect(JSON.stringify(records)).not.toContain("oidc-test-token");
    expect(JSON.stringify(runMatrix.mock.calls[0]?.[0])).not.toContain("oidc-test-token");
    expect(requestHeaders.map((headers) => headers.get("authorization"))).toEqual([
      "Bearer oidc-test-token",
      "Bearer oidc-test-token",
    ]);
    expect(requestHeaders.map((headers) => headers.get("x-vercel-trusted-oidc-idp-token"))).toEqual(
      ["oidc-test-token", "oidc-test-token"],
    );
    expect(requestRedirects).toEqual(["error", "error"]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops the Sandbox when the matrix fails", async () => {
    const stop = vi.fn(async () => undefined);
    await expect(
      runSandboxBenchmarkCommand(sandboxConfig(), {
        createRunId: () => "run-sandbox",
        async runMatrix() {
          throw new Error("matrix failed");
        },
        serverGroup: fakeSandboxGroup(stop),
        writeRecord: vi.fn(),
      }),
    ).rejects.toThrow("matrix failed");
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

function fakeGroup(stop: (runtimeKind: string) => Promise<void>): LocalRuntimeServerGroup {
  return new LocalRuntimeServerGroup((runtimeKind) => ({
    async readRecordFile() {
      return nullTelemetryJsonl(runtimeKind, "sample-test");
    },
    async stop() {
      await stop(runtimeKind);
    },
    url: Promise.resolve(`http://${runtimeKind}.example`),
  }));
}

function nullTelemetryJsonl(runtimeKind: string, sampleId: string): string {
  return `${JSON.stringify({ kind: "mark", name: "runtime.park.accepted", runtime: runtimeKind, sampleId })}\n`;
}

function fakeSandboxGroup(stop: () => Promise<void>): SandboxRuntimeServerGroupHandle {
  return {
    async readRecordFile() {
      return null;
    },
    async start() {
      return {
        runtimeUrls: {
          inline: "https://inline.sandbox.example",
          temporal: "https://temporal.sandbox.example",
          workflow: "https://workflow.sandbox.example",
        },
        sandbox: {
          memoryMb: 8192,
          name: "benchmark-sandbox",
          region: "iad1",
          runtime: "node24",
          vcpus: 4,
        },
      };
    },
    stop,
  };
}

function sandboxConfig() {
  return {
    gitRevision: "0123456789abcdef0123456789abcdef01234567",
    gitUrl: "https://github.com/vercel/eve.git",
    measuredBlocks: 2,
    modelCredential: { name: "AI_GATEWAY_API_KEY" as const, value: "gateway-test-key" },
    modelKind: "live" as const,
    mode: "sandbox" as const,
    seed: 7,
    vercelOidc: {
      environment: "development",
      projectId: "prj_benchmark",
      token: "oidc-test-token",
    },
    warmupBlocks: 1,
  };
}

function summary(config: BenchmarkMatrixConfig): BenchmarkSummaryRecord {
  const emptyCounts = { failed: 0, invalid: 0, valid: 0 };
  const emptyMetrics = {
    firstDecodedEventMs: null,
    firstTextEventReceivedToStopStepCompletedMs: null,
    firstVisibleTextMs: null,
    postAckMs: null,
    postAckToSessionStartedEventReceivedMs: null,
    reducerTotalMs: null,
    sessionStartedToToolRequestEventReceivedMs: null,
    sessionWaitingEventReceivedMs: null,
    sessionWaitingReducedMs: null,
    stopStepCompletedToSessionWaitingEventReceivedMs: null,
    toolRequestToToolStepCompletedEventReceivedMs: null,
    toolStepCompletedToFirstTextEventReceivedMs: null,
  };
  return {
    blocks: { measured: config.measuredBlocks, warmup: config.warmupBlocks },
    correctness: {
      measured: { inline: emptyCounts, temporal: emptyCounts, workflow: emptyCounts },
      warmup: { inline: emptyCounts, temporal: emptyCounts, workflow: emptyCounts },
    },
    kind: "summary",
    measuredClientMetrics: {
      inline: emptyMetrics,
      temporal: emptyMetrics,
      workflow: emptyMetrics,
    },
    modelKind: config.modelKind,
    pairedMeasuredClientDifferences: {
      "temporal-minus-inline": emptyMetrics,
      "temporal-minus-workflow": emptyMetrics,
      "workflow-minus-inline": emptyMetrics,
    },
    runId: config.runId,
    seed: config.seed,
    serverTelemetry: {
      measuredSummedIntervalDurationsMsByName: { inline: {}, temporal: {}, workflow: {} },
      pairedMeasuredSummedIntervalDurationDifferencesMsByName: {
        "temporal-minus-inline": {},
        "temporal-minus-workflow": {},
        "workflow-minus-inline": {},
      },
      statusCounts: {
        measured: {
          inline: { complete: 0, failed: 0, incomplete: 0, unavailable: 0 },
          temporal: { complete: 0, failed: 0, incomplete: 0, unavailable: 0 },
          workflow: { complete: 0, failed: 0, incomplete: 0, unavailable: 0 },
        },
        warmup: {
          inline: { complete: 0, failed: 0, incomplete: 0, unavailable: 0 },
          temporal: { complete: 0, failed: 0, incomplete: 0, unavailable: 0 },
          workflow: { complete: 0, failed: 0, incomplete: 0, unavailable: 0 },
        },
      },
    },
    targetKind: config.targetKind,
  };
}
