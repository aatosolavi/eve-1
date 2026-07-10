import { describe, expect, it, vi } from "vitest";

import { readServerTelemetry } from "./server-telemetry.js";

describe("readServerTelemetry", () => {
  it("filters the exact sample and runtime and sums only local valid intervals", async () => {
    const text = jsonl([
      interval("sample-1", "inline", "model", "clock-a", 2, "clock-a", 7),
      interval("sample-1", "inline", "model", "clock-a", 8, "clock-a", 11),
      interval("sample-1", "inline", "cross-clock", "clock-a", 1, "clock-b", 9),
      interval("sample-1", "inline", "backwards", "clock-a", 9, "clock-a", 3),
      interval("sample-2", "inline", "model", "clock-a", 0, "clock-a", 100),
      interval("sample-1", "workflow", "model", "clock-a", 0, "clock-a", 100),
    ]);
    const nonFiniteInterval =
      '{"kind":"interval","name":"non-finite","runtime":"inline","sampleId":"sample-1","start":{"clockDomainId":"clock-a","monotonicMs":0},"end":{"clockDomainId":"clock-a","monotonicMs":1e999}}\n';
    let now = 0;

    const result = await readServerTelemetry({
      expectedRuntime: "inline",
      expectedSampleId: "sample-1",
      now: () => now,
      pollIntervalMs: 5,
      quietPeriodMs: 5,
      readText: async () => `${text}${nonFiniteInterval}{"kind":"interval"`,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      waitForPark: false,
    });

    expect(result).toMatchObject({
      status: "complete",
      summedIntervalDurationsMsByName: { model: 8 },
    });
    expect(result.rawRecords).toHaveLength(5);
  });

  it("polls until the exact sample and runtime publish the park mark", async () => {
    const reads = [
      undefined,
      jsonl([mark("other-sample", "inline", "runtime.park.accepted")]),
      `${jsonl([mark("sample-1", "inline", "runtime.started")])}${JSON.stringify(
        mark("sample-1", "inline", "runtime.park.accepted"),
      )}`,
      jsonl([
        mark("sample-1", "inline", "runtime.started"),
        mark("sample-1", "inline", "runtime.park.accepted"),
      ]),
    ];
    let now = 0;
    const sleep = vi.fn(async (durationMs: number) => {
      now += durationMs;
    });

    const result = await readServerTelemetry({
      expectedRuntime: "inline",
      expectedSampleId: "sample-1",
      now: () => now,
      pollIntervalMs: 5,
      readText: async () => reads.shift(),
      sleep,
      timeoutMs: 30,
      waitForPark: true,
    });

    expect(result.status).toBe("complete");
    expect(result.rawRecords.map((record) => record.kind)).toEqual(["mark", "mark"]);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("returns incomplete with the latest records when park does not arrive before timeout", async () => {
    let now = 0;
    const result = await readServerTelemetry({
      expectedRuntime: "temporal",
      expectedSampleId: "sample-1",
      now: () => now,
      pollIntervalMs: 5,
      readText: async () => jsonl([mark("sample-1", "temporal", "runtime.started")]),
      sleep: async (durationMs) => {
        now += durationMs;
      },
      timeoutMs: 10,
      waitForPark: true,
    });

    expect(result.status).toBe("incomplete");
    expect(result.rawRecords).toHaveLength(1);
  });

  it("returns unavailable when the reader has no telemetry by the deadline", async () => {
    let now = 0;
    const result = await readServerTelemetry({
      expectedRuntime: "workflow",
      expectedSampleId: "sample-1",
      now: () => now,
      readText: async () => undefined,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      timeoutMs: 25,
      waitForPark: true,
    });

    expect(result).toEqual({
      rawRecords: [],
      status: "unavailable",
      summedIntervalDurationsMsByName: {},
    });
  });

  it("returns incomplete after a quiet window when available telemetry does not match", async () => {
    let now = 0;
    const readText = vi.fn(async () => jsonl([mark("other", "inline", "runtime.started")]));
    const result = await readServerTelemetry({
      expectedRuntime: "inline",
      expectedSampleId: "sample-1",
      now: () => now,
      pollIntervalMs: 5,
      quietPeriodMs: 5,
      readText,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      waitForPark: false,
    });

    expect(result.status).toBe("incomplete");
    expect(result.rawRecords).toEqual([]);
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("waits for failed-sample telemetry to stop changing before returning it", async () => {
    const first = jsonl([mark("sample-1", "inline", "runtime.started")]);
    const complete = jsonl([
      mark("sample-1", "inline", "runtime.started"),
      interval("sample-1", "inline", "turn.step.operation", "clock-a", 1, "clock-a", 4),
    ]);
    const reads = [first, first, complete, complete, complete];
    let now = 0;
    const readText = vi.fn(async () => reads.shift() ?? complete);

    const result = await readServerTelemetry({
      expectedRuntime: "inline",
      expectedSampleId: "sample-1",
      now: () => now,
      pollIntervalMs: 5,
      quietPeriodMs: 10,
      readText,
      sleep: async (durationMs) => {
        now += durationMs;
      },
      timeoutMs: 30,
      waitForPark: false,
    });

    expect(result).toMatchObject({
      status: "complete",
      summedIntervalDurationsMsByName: { "turn.step.operation": 3 },
    });
    expect(result.rawRecords).toHaveLength(2);
    expect(readText).toHaveBeenCalledTimes(5);
  });

  it("returns failed for a malformed complete JSONL record", async () => {
    const result = await readServerTelemetry({
      expectedRuntime: "inline",
      expectedSampleId: "sample-1",
      readText: async () => "{not-json}\n",
      waitForPark: false,
    });

    expect(result).toMatchObject({
      error: { name: "TypeError" },
      status: "failed",
    });
  });

  it("returns failed when the telemetry reader rejects", async () => {
    const result = await readServerTelemetry({
      expectedRuntime: "inline",
      expectedSampleId: "sample-1",
      readText: async () => {
        throw new Error("sandbox read failed");
      },
      waitForPark: false,
    });

    expect(result).toMatchObject({
      error: { message: "sandbox read failed", name: "Error" },
      status: "failed",
    });
  });

  it("returns failed when polling cannot sleep", async () => {
    const result = await readServerTelemetry({
      expectedRuntime: "inline",
      expectedSampleId: "sample-1",
      readText: async () => jsonl([mark("sample-1", "inline", "runtime.started")]),
      sleep: async () => {
        throw new Error("timer failed");
      },
      waitForPark: true,
    });

    expect(result).toMatchObject({
      error: { message: "timer failed", name: "Error" },
      status: "failed",
    });
  });
});

function mark(sampleId: string, runtime: "inline" | "temporal" | "workflow", name: string) {
  return { kind: "mark", name, runtime, sampleId };
}

function interval(
  sampleId: string,
  runtime: "inline" | "temporal" | "workflow",
  name: string,
  startClock: string,
  start: number,
  endClock: string,
  end: number,
) {
  return {
    end: { clockDomainId: endClock, monotonicMs: end },
    kind: "interval",
    name,
    runtime,
    sampleId,
    start: { clockDomainId: startClock, monotonicMs: start },
  };
}

function jsonl(values: readonly unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}
