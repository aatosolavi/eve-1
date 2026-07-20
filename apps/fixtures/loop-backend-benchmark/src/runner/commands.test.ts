import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BenchmarkSampleResult,
  RunBenchmarkSampleInput,
  runBenchmarkSample,
} from "../driver/index.js";

import {
  runHostedBenchmarkCommand,
  runLocalBenchmarkCommand,
  runSandboxBenchmarkCommand,
  type LocalSetupRecord,
} from "./commands.js";
import { LocalRuntimeServerHost } from "./local-servers.js";
import { completeBenchmarkRun, executeBenchmarkSamples } from "./matrix.js";
import type {
  SandboxRuntimeServerHostHandle,
  SandboxRuntimeServerLease,
  SandboxSetupRecord,
} from "./sandbox-servers.js";
import type { BenchmarkJsonlRecord } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runLocalBenchmarkCommand", () => {
  it("runs one warm process per runtime batch and writes one combined summary", async () => {
    const calls: string[] = [];
    const records: Array<LocalSetupRecord | BenchmarkJsonlRecord> = [];
    let activeServers = 0;
    let maximumActiveServers = 0;
    let currentSampleId = "";
    const serverHost = new LocalRuntimeServerHost((runtimeKind) => {
      activeServers += 1;
      maximumActiveServers = Math.max(maximumActiveServers, activeServers);
      calls.push(`start:${runtimeKind}`);
      return {
        async readRecordFile() {
          calls.push(`telemetry:${runtimeKind}:${currentSampleId}`);
          return nullTelemetryJsonl(runtimeKind, currentSampleId);
        },
        async stop() {
          calls.push(`stop:${runtimeKind}`);
          activeServers -= 1;
        },
        url: Promise.resolve(`http://${runtimeKind}.example`),
      };
    });
    const executeSamples: typeof executeBenchmarkSamples = async (input, overrides) =>
      await executeBenchmarkSamples(input, {
        ...overrides,
        async runSample(sample) {
          currentSampleId = sample.sampleId;
          calls.push(`sample:${sample.runtimeKind}:${sample.sampleId}`);
          return validResultFor(sample);
        },
      });
    const acquire = vi.spyOn(serverHost, "acquire");

    const result = await runLocalBenchmarkCommand(
      {
        measuredBlocks: 1,
        modelKind: "deterministic",
        mode: "local",
        seed: 7,
        warmupBlocks: 1,
      },
      {
        completeRun: completeBenchmarkRun,
        createRunId: () => "run-local",
        executeSamples,
        serverHost,
        writeRecord(record) {
          records.push(record);
        },
      },
    );

    expect(maximumActiveServers).toBe(1);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(result.kind).toBe("summary");
    expect(records).toHaveLength(8);
    expect(records.at(-1)).toBe(result);
    const setup = records[0];
    expect(setup).toMatchObject({
      kind: "setup",
      maxConcurrentRuntimeServers: 1,
      runId: "run-local",
      runtimeReuse: "one-process-per-runtime",
      topology: "local-runtime-batches",
    });
    expect(setup).not.toHaveProperty("runtimeUrls");
    if (setup?.kind !== "setup") throw new Error("Expected local setup record first.");
    expect(acquire.mock.calls.map(([runtimeKind]) => runtimeKind)).toEqual(setup.runtimeBatchOrder);

    const samples = records.flatMap((record) => (record.kind === "sample" ? [record] : []));
    expect(samples).toHaveLength(6);
    expect(samples.map((sample) => sample.sampleIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(samples.map((sample) => sample.result.runtimeKind)).toEqual(
      setup.runtimeBatchOrder.flatMap((runtimeKind) => [runtimeKind, runtimeKind]),
    );
    for (const runtimeKind of setup.runtimeBatchOrder) {
      const startIndex = calls.indexOf(`start:${runtimeKind}`);
      const stopIndex = calls.indexOf(`stop:${runtimeKind}`);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(stopIndex).toBeGreaterThan(startIndex);
      expect(
        calls.filter(
          (call, index) =>
            index > startIndex && index < stopIndex && call.startsWith(`telemetry:${runtimeKind}:`),
        ),
      ).toHaveLength(2);
    }
  });

  it("stops the active runtime when sample execution throws", async () => {
    const stop = vi.fn(async () => undefined);
    const serverHost = new LocalRuntimeServerHost((runtimeKind) => ({
      async readRecordFile() {
        return undefined;
      },
      stop,
      url: Promise.resolve(`http://${runtimeKind}.example`),
    }));
    const acquire = vi.spyOn(serverHost, "acquire");
    const completeRun = vi.fn(completeBenchmarkRun);

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
          completeRun,
          createRunId: () => "run-local",
          async executeSamples() {
            throw new Error("sample execution failed");
          },
          serverHost,
          writeRecord: vi.fn(),
        },
      ),
    ).rejects.toThrow("sample execution failed");
    expect(acquire).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(completeRun).not.toHaveBeenCalled();
  });

  it("preserves both sample execution and server cleanup failures", async () => {
    const sampleFailure = new Error("sample execution failed");
    const cleanupFailure = new Error("server cleanup failed");
    const serverHost = new LocalRuntimeServerHost((runtimeKind) => ({
      async readRecordFile() {
        return undefined;
      },
      async stop() {
        throw cleanupFailure;
      },
      url: Promise.resolve(`http://${runtimeKind}.example`),
    }));

    const failure = await runLocalBenchmarkCommand(
      {
        measuredBlocks: 1,
        modelKind: "deterministic",
        mode: "local",
        seed: 7,
        warmupBlocks: 0,
      },
      {
        completeRun: completeBenchmarkRun,
        createRunId: () => "run-local",
        async executeSamples() {
          throw sampleFailure;
        },
        serverHost,
        writeRecord: vi.fn(),
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([sampleFailure, cleanupFailure]);
  });
});

describe("runHostedBenchmarkCommand", () => {
  it("runs one authenticated hosted runtime with client-only telemetry", async () => {
    const records: BenchmarkJsonlRecord[] = [];
    const runSample = vi.fn<typeof runBenchmarkSample>(async (input, options) => {
      expect(options).toEqual({ vercelOidcToken: "hosted-oidc-token" });
      return validResultFor(input);
    });

    const result = await runHostedBenchmarkCommand(
      {
        measuredBlocks: 2,
        modelKind: "live",
        mode: "hosted",
        runtimeKind: "workflow",
        targetUrl: "https://workflow.example",
        vercelOidcToken: "hosted-oidc-token",
        warmupBlocks: 1,
      },
      {
        createRunId: () => "run-hosted",
        runSample,
        writeRecord(record) {
          records.push(record);
        },
      },
    );

    expect(runSample).toHaveBeenCalledTimes(3);
    expect(
      runSample.mock.calls.map(([input]) => ({
        nonce: input.nonce,
        runtimeKind: input.runtimeKind,
        targetUrl: input.targetUrl,
      })),
    ).toEqual([
      {
        nonce: "run-hosted:nonce:warmup:0",
        runtimeKind: "workflow",
        targetUrl: "https://workflow.example",
      },
      {
        nonce: "run-hosted:nonce:measured:0",
        runtimeKind: "workflow",
        targetUrl: "https://workflow.example",
      },
      {
        nonce: "run-hosted:nonce:measured:1",
        runtimeKind: "workflow",
        targetUrl: "https://workflow.example",
      },
    ]);
    const sampleRecords = records.flatMap((record) => (record.kind === "sample" ? [record] : []));
    expect(sampleRecords.map((record) => record.blockIndex)).toEqual([0, 0, 1]);
    expect(sampleRecords.map((record) => record.sampleIndex)).toEqual([0, 1, 2]);
    expect(sampleRecords.map((record) => record.orderInBlock)).toEqual([0, 0, 0]);
    expect(sampleRecords.map((record) => record.serverTelemetry.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(records.at(-1)).toBe(result);
    expect(result).toMatchObject({
      correctness: {
        measured: {
          inline: { failed: 0, invalid: 0, valid: 0 },
          temporal: { failed: 0, invalid: 0, valid: 0 },
          workflow: { failed: 0, invalid: 0, valid: 2 },
        },
      },
      runId: "run-hosted",
      seed: null,
      serverTelemetry: {
        statusCounts: {
          measured: {
            workflow: { complete: 0, failed: 0, incomplete: 0, unavailable: 2 },
          },
        },
      },
      targetKind: "vercel",
    });
    expect(result.pairedMeasuredClientDifferences["workflow-minus-inline"].postAckMs).toBeNull();
    expect(result.serverTelemetry.measuredSummedIntervalDurationsMsByName.workflow).toEqual({});
  });
});

describe("runSandboxBenchmarkCommand", () => {
  it("runs one Sandbox process per runtime batch and writes one combined summary", async () => {
    const callOrder: string[] = [];
    const records: Array<SandboxSetupRecord | BenchmarkJsonlRecord> = [];
    const requestHeaders: Headers[] = [];
    const requestRedirects: Array<"error" | "follow" | "manual" | undefined> = [];
    let activeServers = 0;
    let maximumActiveServers = 0;
    let currentSampleId = "";
    const stopSandbox = vi.fn(async () => {
      callOrder.push("stop:sandbox");
    });
    const serverHost: SandboxRuntimeServerHostHandle = {
      async acquire(runtimeKind) {
        activeServers += 1;
        maximumActiveServers = Math.max(maximumActiveServers, activeServers);
        callOrder.push(`start:${runtimeKind}`);
        return {
          async readRecordFile() {
            callOrder.push(`telemetry:${runtimeKind}:${currentSampleId}`);
            return nullTelemetryJsonl(runtimeKind, currentSampleId);
          },
          runtimeKind,
          async stop() {
            callOrder.push(`stop:${runtimeKind}`);
            activeServers -= 1;
          },
          targetUrl: `https://${runtimeKind}.sandbox.example`,
        };
      },
      async prepare() {
        callOrder.push("prepare");
        return sandboxMetadata();
      },
      stop: stopSandbox,
    };
    const acquire = vi.spyOn(serverHost, "acquire");
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
    let checkedAuthenticatedRequest = false;
    const executeSamples: typeof executeBenchmarkSamples = async (input, overrides) =>
      await executeBenchmarkSamples(input, {
        ...overrides,
        async runSample(sample) {
          currentSampleId = sample.sampleId;
          callOrder.push(`sample:${sample.runtimeKind}:${sample.sampleId}`);
          if (!checkedAuthenticatedRequest) {
            checkedAuthenticatedRequest = true;
            await overrides?.runSample?.(sample);
          }
          return validResultFor(sample);
        },
      });

    const result = await runSandboxBenchmarkCommand(sandboxConfig(), {
      completeRun: completeBenchmarkRun,
      createRunId: () => "run-sandbox",
      executeSamples,
      serverHost,
      writeRecord(record) {
        callOrder.push(`write:${record.kind}`);
        records.push(record);
      },
    });

    expect(maximumActiveServers).toBe(1);
    expect(acquire).toHaveBeenCalledTimes(3);
    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(result.kind).toBe("summary");
    expect(records).toHaveLength(11);
    expect(records.at(-1)).toBe(result);
    const setup = records[0];
    expect(setup).toMatchObject({
      gitRevision: "0123456789abcdef0123456789abcdef01234567",
      kind: "setup",
      maxConcurrentRuntimeServers: 1,
      modelKind: "live",
      runId: "run-sandbox",
      runtimeReuse: "one-process-per-runtime",
      sandbox: sandboxMetadata(),
      sandboxReuse: "one-sandbox-per-run",
      targetKind: "vercel",
      topology: "vercel-sandbox-runtime-batches",
    });
    expect(setup).not.toHaveProperty("runtimeUrls");
    if (setup?.kind !== "setup") throw new Error("Expected Sandbox setup record first.");
    expect(acquire.mock.calls.map(([runtimeKind]) => runtimeKind)).toEqual(setup.runtimeBatchOrder);

    const samples = records.flatMap((record) => (record.kind === "sample" ? [record] : []));
    expect(samples).toHaveLength(9);
    expect(samples.map((sample) => sample.sampleIndex)).toEqual(
      Array.from({ length: 9 }, (_, index) => index),
    );
    expect(samples.map((sample) => sample.result.runtimeKind)).toEqual(
      setup.runtimeBatchOrder.flatMap((runtimeKind) => [runtimeKind, runtimeKind, runtimeKind]),
    );
    for (const runtimeKind of setup.runtimeBatchOrder) {
      const startIndex = callOrder.indexOf(`start:${runtimeKind}`);
      const stopIndex = callOrder.indexOf(`stop:${runtimeKind}`);
      expect(startIndex).toBeGreaterThan(callOrder.indexOf("write:setup"));
      expect(stopIndex).toBeGreaterThan(startIndex);
      expect(
        callOrder.filter(
          (call, index) =>
            index > startIndex && index < stopIndex && call.startsWith(`sample:${runtimeKind}:`),
        ),
      ).toHaveLength(3);
    }
    expect(callOrder.at(-1)).toBe("stop:sandbox");
    expect(JSON.stringify(records)).not.toContain("oidc-test-token");
    expect(requestHeaders.map((headers) => headers.get("authorization"))).toEqual([
      "Bearer oidc-test-token",
      "Bearer oidc-test-token",
    ]);
    expect(requestHeaders.map((headers) => headers.get("x-vercel-trusted-oidc-idp-token"))).toEqual(
      ["oidc-test-token", "oidc-test-token"],
    );
    expect(requestRedirects).toEqual(["error", "error"]);
  });

  it("stops the active runtime and Sandbox when sample execution fails", async () => {
    const stopRuntime = vi.fn(async () => undefined);
    const stopSandbox = vi.fn(async () => undefined);
    await expect(
      runSandboxBenchmarkCommand(sandboxConfig(), {
        completeRun: completeBenchmarkRun,
        createRunId: () => "run-sandbox",
        async executeSamples() {
          throw new Error("sample execution failed");
        },
        serverHost: fakeSandboxHost({ stopRuntime, stopSandbox }),
        writeRecord: vi.fn(),
      }),
    ).rejects.toThrow("sample execution failed");
    expect(stopRuntime).toHaveBeenCalledOnce();
    expect(stopSandbox).toHaveBeenCalledOnce();
  });

  it("preserves sample, runtime cleanup, and Sandbox cleanup failures", async () => {
    const sampleFailure = new Error("sample execution failed");
    const runtimeCleanupFailure = new Error("runtime cleanup failed");
    const sandboxCleanupFailure = new Error("Sandbox cleanup failed");

    const failure = await runSandboxBenchmarkCommand(sandboxConfig(), {
      completeRun: completeBenchmarkRun,
      createRunId: () => "run-sandbox",
      async executeSamples() {
        throw sampleFailure;
      },
      serverHost: fakeSandboxHost({
        stopRuntime: async () => {
          throw runtimeCleanupFailure;
        },
        stopSandbox: async () => {
          throw sandboxCleanupFailure;
        },
      }),
      writeRecord: vi.fn(),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      sampleFailure,
      runtimeCleanupFailure,
      sandboxCleanupFailure,
    ]);
  });
});

function nullTelemetryJsonl(runtimeKind: string, sampleId: string): string {
  return `${JSON.stringify({ kind: "mark", name: "runtime.park.accepted", runtime: runtimeKind, sampleId })}\n`;
}

function validResultFor(input: RunBenchmarkSampleInput): BenchmarkSampleResult {
  return {
    ...input,
    finalVisibleMessage: `benchmark-verified:${input.nonce}`,
    measurements: {
      events: [],
      firstDecodedEventMs: 2,
      firstTextEventReceivedToStopStepCompletedMs: 0.1,
      firstVisibleTextMs: 3,
      postAckMs: 1,
      postAckToSessionStartedEventReceivedMs: 0.2,
      reducerTotalMs: 0.1,
      sessionStartedToToolRequestEventReceivedMs: 0.3,
      sessionWaitingEventReceivedMs: 4,
      sessionWaitingReducedMs: 4,
      stopStepCompletedToSessionWaitingEventReceivedMs: 0.1,
      toolRequestToToolStepCompletedEventReceivedMs: 0.1,
      toolStepCompletedToFirstTextEventReceivedMs: 0.2,
    },
    outcome: "valid",
    sessionId: `session-${input.sampleId}`,
  };
}

function fakeSandboxHost(input: {
  readonly stopRuntime: () => Promise<void>;
  readonly stopSandbox: () => Promise<void>;
}): SandboxRuntimeServerHostHandle {
  return {
    async acquire<RuntimeKind extends SandboxRuntimeServerLease["runtimeKind"]>(
      runtimeKind: RuntimeKind,
    ) {
      return {
        async readRecordFile() {
          return null;
        },
        runtimeKind,
        stop: input.stopRuntime,
        targetUrl: `https://${runtimeKind}.sandbox.example`,
      };
    },
    async prepare() {
      return sandboxMetadata();
    },
    stop: input.stopSandbox,
  };
}

function sandboxMetadata() {
  return {
    memoryMb: 8192,
    name: "benchmark-sandbox",
    region: "iad1",
    runtime: "node24",
    vcpus: 4,
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
