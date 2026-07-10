import type { BenchmarkSampleResult, RunBenchmarkSampleInput } from "../driver/index.js";
import { describe, expect, it, vi } from "vitest";

import { runBenchmarkMatrix } from "./matrix.js";
import type { BenchmarkJsonlRecord, BenchmarkMatrixConfig } from "./types.js";

describe("runBenchmarkMatrix", () => {
  it("runs serial complete blocks and writes one record per sample plus the summary", async () => {
    const inputs: RunBenchmarkSampleInput[] = [];
    const records: BenchmarkJsonlRecord[] = [];
    let activeSamples = 0;
    let maximumActiveSamples = 0;

    const summary = await runBenchmarkMatrix(config(), {
      async runSample(input) {
        activeSamples += 1;
        maximumActiveSamples = Math.max(maximumActiveSamples, activeSamples);
        await Promise.resolve();
        inputs.push(input);
        activeSamples -= 1;
        return resultFor(input);
      },
      writeRecord(record) {
        records.push(record);
      },
    });

    expect(maximumActiveSamples).toBe(1);
    expect(inputs).toHaveLength(9);
    expect(records).toHaveLength(10);
    expect(records.at(-1)).toBe(summary);
    expect(records.slice(0, -1).every((record) => record.kind === "sample")).toBe(true);
    expect(records.every((record) => record.modelKind === "deterministic")).toBe(true);
    expect(
      records.flatMap((record) =>
        record.kind === "sample" ? [record.serverTelemetry.status] : [],
      ),
    ).toEqual(Array.from({ length: 9 }, () => "unavailable"));

    const warmupInputs = inputs.slice(0, 3);
    const measuredInputs = inputs.slice(3);
    expect(new Set(warmupInputs.map((input) => input.runtimeKind))).toEqual(
      new Set(["inline", "workflow", "temporal"]),
    );
    for (let offset = 0; offset < measuredInputs.length; offset += 3) {
      const block = measuredInputs.slice(offset, offset + 3);
      expect(new Set(block.map((input) => input.runtimeKind))).toEqual(
        new Set(["inline", "workflow", "temporal"]),
      );
      expect(new Set(block.map((input) => input.nonce))).toHaveLength(1);
    }
  });

  it("preserves valid, invalid, and failed sample results in JSONL records", async () => {
    const records: BenchmarkJsonlRecord[] = [];
    const collectServerTelemetry = vi.fn(async () => ({
      rawRecords: [],
      status: "complete" as const,
      summedIntervalDurationsMsByName: { "engine.dispatch": 4 },
    }));
    await runBenchmarkMatrix(
      { ...config(), measuredBlocks: 1, warmupBlocks: 0 },
      {
        collectServerTelemetry,
        async runSample(input) {
          return resultFor(input);
        },
        writeRecord(record) {
          records.push(record);
        },
      },
    );

    expect(
      records.flatMap((record) => (record.kind === "sample" ? [record.result.outcome] : [])),
    ).toEqual(expect.arrayContaining(["valid", "invalid", "failed"]));
    expect(collectServerTelemetry).toHaveBeenCalledTimes(3);
    expect(
      records.flatMap((record) =>
        record.kind === "sample" ? [record.serverTelemetry.status] : [],
      ),
    ).toEqual(["complete", "complete", "complete"]);
  });
});

function config(): BenchmarkMatrixConfig {
  return {
    measuredBlocks: 2,
    modelKind: "deterministic",
    runId: "run-fixed",
    runtimeUrls: {
      inline: "http://inline.example",
      temporal: "http://temporal.example",
      workflow: "http://workflow.example",
    },
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
