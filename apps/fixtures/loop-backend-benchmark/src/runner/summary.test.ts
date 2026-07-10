import type { BenchmarkRuntimeKind, BenchmarkSampleResult } from "../driver/index.js";
import { describe, expect, it } from "vitest";

import { calculatePercentiles, summarizeBenchmarkMatrix } from "./summary.js";
import type { BenchmarkMatrixConfig, BenchmarkSampleRecord } from "./types.js";

describe("calculatePercentiles", () => {
  it("uses the nearest-rank definition", () => {
    expect(calculatePercentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({
      count: 10,
      p50: 5,
      p90: 9,
      p95: 10,
    });
    expect(calculatePercentiles([])).toBeNull();
  });
});

describe("summarizeBenchmarkMatrix", () => {
  it("gates metrics on correctness and calculates paired client differences by block", () => {
    const samples: BenchmarkSampleRecord[] = [
      sample("warmup", 0, validResult("inline", 90), completeTelemetry({ "engine.dispatch": 90 })),
      sample("warmup", 0, invalidResult("workflow"), unavailableTelemetry()),
      sample("warmup", 0, failedResult("temporal"), failedTelemetry()),
      sample(
        "measured",
        0,
        validResult("inline", 100),
        completeTelemetry({ "engine.dispatch": 100 }),
      ),
      sample(
        "measured",
        0,
        validResult("workflow", 120),
        completeTelemetry({ "engine.dispatch": 120 }),
      ),
      sample(
        "measured",
        0,
        validResult("temporal", 150),
        completeTelemetry({ "engine.dispatch": 150 }),
      ),
      sample(
        "measured",
        1,
        validResult("inline", 200),
        completeTelemetry({ "engine.dispatch": 200 }),
      ),
      sample(
        "measured",
        1,
        invalidResult("workflow"),
        completeTelemetry({ "engine.dispatch": 999 }),
      ),
      sample(
        "measured",
        1,
        validResult("temporal", 260),
        completeTelemetry({ "engine.dispatch": 260 }),
      ),
    ];
    const summary = summarizeBenchmarkMatrix({ config: config(), samples });

    expect(summary.modelKind).toBe("deterministic");
    expect(summary.correctness).toEqual({
      measured: {
        inline: { failed: 0, invalid: 0, valid: 2 },
        temporal: { failed: 0, invalid: 0, valid: 2 },
        workflow: { failed: 0, invalid: 1, valid: 1 },
      },
      warmup: {
        inline: { failed: 0, invalid: 0, valid: 1 },
        temporal: { failed: 1, invalid: 0, valid: 0 },
        workflow: { failed: 0, invalid: 1, valid: 0 },
      },
    });
    expect(summary.measuredClientMetrics.inline.postAckMs).toEqual({
      count: 2,
      p50: 100,
      p90: 200,
      p95: 200,
    });
    expect(summary.measuredClientMetrics.workflow.postAckMs).toEqual({
      count: 1,
      p50: 120,
      p90: 120,
      p95: 120,
    });
    expect(summary.pairedMeasuredClientDifferences["workflow-minus-inline"].postAckMs).toEqual({
      count: 1,
      p50: 20,
      p90: 20,
      p95: 20,
    });
    expect(summary.pairedMeasuredClientDifferences["temporal-minus-inline"].postAckMs).toEqual({
      count: 2,
      p50: 50,
      p90: 60,
      p95: 60,
    });
    expect(summary.serverTelemetry.statusCounts).toEqual({
      measured: {
        inline: { complete: 2, failed: 0, incomplete: 0, unavailable: 0 },
        temporal: { complete: 2, failed: 0, incomplete: 0, unavailable: 0 },
        workflow: { complete: 2, failed: 0, incomplete: 0, unavailable: 0 },
      },
      warmup: {
        inline: { complete: 1, failed: 0, incomplete: 0, unavailable: 0 },
        temporal: { complete: 0, failed: 1, incomplete: 0, unavailable: 0 },
        workflow: { complete: 0, failed: 0, incomplete: 0, unavailable: 1 },
      },
    });
    expect(
      summary.serverTelemetry.measuredSummedIntervalDurationsMsByName.inline["engine.dispatch"],
    ).toEqual({ count: 2, p50: 100, p90: 200, p95: 200 });
    expect(
      summary.serverTelemetry.measuredSummedIntervalDurationsMsByName.workflow["engine.dispatch"],
    ).toEqual({ count: 1, p50: 120, p90: 120, p95: 120 });
    expect(
      summary.serverTelemetry.pairedMeasuredSummedIntervalDurationDifferencesMsByName[
        "workflow-minus-inline"
      ]["engine.dispatch"],
    ).toEqual({ count: 1, p50: 20, p90: 20, p95: 20 });
    expect(
      summary.serverTelemetry.pairedMeasuredSummedIntervalDurationDifferencesMsByName[
        "temporal-minus-inline"
      ]["engine.dispatch"],
    ).toEqual({ count: 2, p50: 50, p90: 60, p95: 60 });
  });
});

function config(): BenchmarkMatrixConfig {
  return {
    measuredBlocks: 2,
    modelKind: "deterministic",
    runId: "run-1",
    runtimeUrls: {
      inline: "http://inline.example",
      temporal: "http://temporal.example",
      workflow: "http://workflow.example",
    },
    seed: 7,
    targetKind: "local",
    warmupBlocks: 1,
  };
}

function sample(
  phase: BenchmarkSampleRecord["phase"],
  blockIndex: number,
  result: BenchmarkSampleResult,
  serverTelemetry: BenchmarkSampleRecord["serverTelemetry"],
): BenchmarkSampleRecord {
  return {
    blockIndex,
    kind: "sample",
    modelKind: "deterministic",
    orderInBlock: 0,
    phase,
    result,
    runId: "run-1",
    sampleIndex: 0,
    serverTelemetry,
  };
}

function completeTelemetry(
  durations: Readonly<Record<string, number>>,
): BenchmarkSampleRecord["serverTelemetry"] {
  return { rawRecords: [], status: "complete", summedIntervalDurationsMsByName: durations };
}

function unavailableTelemetry(): BenchmarkSampleRecord["serverTelemetry"] {
  return { rawRecords: [], status: "unavailable", summedIntervalDurationsMsByName: {} };
}

function failedTelemetry(): BenchmarkSampleRecord["serverTelemetry"] {
  return {
    error: { message: "record read failed", name: "Error" },
    rawRecords: [],
    status: "failed",
    summedIntervalDurationsMsByName: {},
  };
}

function validResult(
  runtimeKind: BenchmarkRuntimeKind,
  postAckMs: number,
): Extract<BenchmarkSampleResult, { readonly outcome: "valid" }> {
  return {
    finalVisibleMessage: "benchmark-verified:nonce",
    measurements: {
      events: [],
      firstDecodedEventMs: postAckMs + 1,
      firstTextEventReceivedToStopStepCompletedMs: 1,
      firstVisibleTextMs: postAckMs + 2,
      postAckMs,
      postAckToSessionStartedEventReceivedMs: 1,
      reducerTotalMs: 1,
      sessionStartedToToolRequestEventReceivedMs: 1,
      sessionWaitingEventReceivedMs: postAckMs + 3,
      sessionWaitingReducedMs: postAckMs + 3,
      stopStepCompletedToSessionWaitingEventReceivedMs: 1,
      toolRequestToToolStepCompletedEventReceivedMs: 1,
      toolStepCompletedToFirstTextEventReceivedMs: 1,
    },
    nonce: "nonce",
    outcome: "valid",
    runtimeKind,
    sampleId: `sample-${runtimeKind}`,
    sessionId: `session-${runtimeKind}`,
    targetKind: "local",
    targetUrl: `http://${runtimeKind}.example`,
  };
}

function invalidResult(runtimeKind: BenchmarkRuntimeKind): BenchmarkSampleResult {
  return {
    ...validResult(runtimeKind, 999),
    issues: [{ actual: 0, expected: 2, kind: "model-step-count" }],
    outcome: "invalid",
  };
}

function failedResult(runtimeKind: BenchmarkRuntimeKind): BenchmarkSampleResult {
  return {
    error: { message: "network error", name: "TypeError" },
    measurements: {
      events: [],
      firstDecodedEventMs: null,
      firstTextEventReceivedToStopStepCompletedMs: null,
      firstVisibleTextMs: null,
      postAckMs: null,
      postAckToSessionStartedEventReceivedMs: null,
      reducerTotalMs: 0,
      sessionStartedToToolRequestEventReceivedMs: null,
      sessionWaitingEventReceivedMs: null,
      sessionWaitingReducedMs: null,
      stopStepCompletedToSessionWaitingEventReceivedMs: null,
      toolRequestToToolStepCompletedEventReceivedMs: null,
      toolStepCompletedToFirstTextEventReceivedMs: null,
    },
    nonce: "nonce",
    outcome: "failed",
    runtimeKind,
    sampleId: `sample-${runtimeKind}`,
    sessionId: null,
    targetKind: "local",
    targetUrl: `http://${runtimeKind}.example`,
  };
}
