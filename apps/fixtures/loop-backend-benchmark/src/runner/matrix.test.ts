import type { BenchmarkSampleResult, RunBenchmarkSampleInput } from "../driver/index.js";
import { describe, expect, it, vi } from "vitest";

import { completeBenchmarkRun, executeBenchmarkSamples } from "./matrix.js";
import type { BenchmarkExecutionSample, BenchmarkRunConfig } from "./types.js";

describe("executeBenchmarkSamples", () => {
  it("uses planned execution indices and collects telemetry before writing each sample", async () => {
    const samples: readonly BenchmarkExecutionSample[] = [
      {
        blockIndex: 1,
        orderInBlock: 2,
        phase: "measured",
        runtimeKind: "temporal",
        sampleIndex: 7,
        targetUrl: "http://temporal-batch.example",
      },
      {
        blockIndex: 0,
        orderInBlock: 0,
        phase: "warmup",
        runtimeKind: "inline",
        sampleIndex: 8,
        targetUrl: "http://inline-batch.example",
      },
    ];
    const calls: string[] = [];

    const records = await executeBenchmarkSamples(
      { config: config(), samples },
      {
        async collectServerTelemetry({ sampleId }) {
          calls.push(`telemetry:${sampleId}`);
          return {
            rawRecords: [],
            status: "complete",
            summedIntervalDurationsMsByName: {},
          };
        },
        async runSample(input) {
          calls.push(`sample:${input.sampleId}`);
          return resultFor(input);
        },
        writeRecord(record) {
          expect(record.kind).toBe("sample");
          if (record.kind === "sample") calls.push(`write:${record.result.sampleId}`);
        },
      },
    );

    expect(records.map((record) => record.sampleIndex)).toEqual([7, 8]);
    expect(records.map((record) => record.orderInBlock)).toEqual([2, 0]);
    expect(records.map((record) => record.result.targetUrl)).toEqual([
      "http://temporal-batch.example",
      "http://inline-batch.example",
    ]);
    expect(calls).toEqual([
      "sample:run-fixed:measured:1:temporal",
      "telemetry:run-fixed:measured:1:temporal",
      "write:run-fixed:measured:1:temporal",
      "sample:run-fixed:warmup:0:inline",
      "telemetry:run-fixed:warmup:0:inline",
      "write:run-fixed:warmup:0:inline",
    ]);
  });
});

describe("completeBenchmarkRun", () => {
  it("writes exactly one summary", () => {
    const writeRecord = vi.fn();

    const summary = completeBenchmarkRun({ config: config(), samples: [] }, writeRecord);

    expect(writeRecord).toHaveBeenCalledOnce();
    expect(writeRecord).toHaveBeenCalledWith(summary);
    expect(summary.kind).toBe("summary");
  });
});

function config(): BenchmarkRunConfig {
  return {
    measuredBlocks: 2,
    modelKind: "deterministic",
    runId: "run-fixed",
    seed: 19,
    targetKind: "local",
    warmupBlocks: 1,
  };
}

function resultFor(input: RunBenchmarkSampleInput): BenchmarkSampleResult {
  const measurements = {
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
  };

  switch (input.runtimeKind) {
    case "inline":
      return {
        ...input,
        finalVisibleMessage: `benchmark-verified:${input.nonce}`,
        measurements,
        outcome: "valid",
        sessionId: `session-${input.sampleId}`,
      };
    case "workflow":
      return {
        ...input,
        finalVisibleMessage: "wrong",
        issues: [{ actual: "wrong", expected: "right", kind: "final-visible-message" }],
        measurements,
        outcome: "invalid",
        sessionId: `session-${input.sampleId}`,
      };
    case "temporal":
      return {
        ...input,
        error: { message: "network error", name: "TypeError" },
        measurements: { ...measurements, postAckMs: null },
        outcome: "failed",
        sessionId: null,
      };
    default: {
      const exhaustive: never = input.runtimeKind;
      return exhaustive;
    }
  }
}
