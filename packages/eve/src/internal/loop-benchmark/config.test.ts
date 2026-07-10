import { describe, expect, it } from "vitest";

import {
  LOOP_BENCHMARK_SAMPLE_ID_HEADER,
  readLoopBenchmarkRecordPath,
  readLoopBenchmarkRuntime,
  readLoopBenchmarkSampleId,
  readLoopBenchmarkTarget,
} from "#internal/loop-benchmark/config.js";

describe("loop benchmark config", () => {
  it("leaves the production Workflow runtime unchanged when no override exists", () => {
    expect(readLoopBenchmarkRuntime({})).toBeUndefined();
  });

  it.each(["inline", "workflow", "temporal"] as const)("accepts the %s runtime", (runtime) => {
    expect(readLoopBenchmarkRuntime({ EVE_LOOP_BENCHMARK_RUNTIME: runtime })).toBe(runtime);
  });

  it("rejects unknown runtime names at the environment boundary", () => {
    expect(() => readLoopBenchmarkRuntime({ EVE_LOOP_BENCHMARK_RUNTIME: "threads" })).toThrow(
      'EVE_LOOP_BENCHMARK_RUNTIME must be "inline", "workflow", or "temporal"',
    );
  });

  it("uses VERCEL_ENV as target evidence", () => {
    expect(readLoopBenchmarkTarget({})).toBe("local");
    expect(readLoopBenchmarkTarget({ VERCEL_ENV: "preview" })).toBe("vercel");
  });

  it("lets a Vercel-hosted process declare its benchmark target explicitly", () => {
    expect(readLoopBenchmarkTarget({ EVE_LOOP_BENCHMARK_TARGET: "vercel" })).toBe("vercel");
    expect(
      readLoopBenchmarkTarget({
        EVE_LOOP_BENCHMARK_TARGET: "local",
        VERCEL_ENV: "preview",
      }),
    ).toBe("local");
  });

  it("rejects unknown benchmark targets", () => {
    expect(() => readLoopBenchmarkTarget({ EVE_LOOP_BENCHMARK_TARGET: "edge" })).toThrow(
      'EVE_LOOP_BENCHMARK_TARGET must be "local" or "vercel"',
    );
  });

  it("reads an optional trimmed record path", () => {
    expect(
      readLoopBenchmarkRecordPath({
        EVE_LOOP_BENCHMARK_RECORD_PATH: "  /tmp/records.jsonl  ",
      }),
    ).toBe("/tmp/records.jsonl");
    expect(readLoopBenchmarkRecordPath({})).toBeUndefined();
    expect(readLoopBenchmarkRecordPath({ EVE_LOOP_BENCHMARK_RECORD_PATH: "  " })).toBeUndefined();
  });

  it("parses a trimmed optional sample id", () => {
    const headers = new Headers({ [LOOP_BENCHMARK_SAMPLE_ID_HEADER]: " sample-17 " });

    expect(readLoopBenchmarkSampleId(headers)).toBe("sample-17");
    expect(readLoopBenchmarkSampleId(new Headers())).toBeUndefined();
  });
});
