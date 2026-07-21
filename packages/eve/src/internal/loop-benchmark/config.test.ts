import { describe, expect, it } from "vitest";

import {
  readLoopBenchmarkRuntime,
  readLoopBenchmarkTemporalDevServer,
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

  it("reads optional Temporal dev-server observability settings", () => {
    expect(
      readLoopBenchmarkTemporalDevServer({
        EVE_LOOP_BENCHMARK_TEMPORAL_DB: " /tmp/temporal.sqlite ",
        EVE_LOOP_BENCHMARK_TEMPORAL_UI_PORT: " 8233 ",
      }),
    ).toEqual({ dbFilename: "/tmp/temporal.sqlite", uiPort: 8233 });
    expect(readLoopBenchmarkTemporalDevServer({})).toEqual({});
    expect(readLoopBenchmarkTemporalDevServer({ EVE_LOOP_BENCHMARK_TEMPORAL_DB: "  " })).toEqual(
      {},
    );
  });

  it("rejects a malformed Temporal UI port", () => {
    expect(() =>
      readLoopBenchmarkTemporalDevServer({ EVE_LOOP_BENCHMARK_TEMPORAL_UI_PORT: "portal" }),
    ).toThrow('must be a port number; received "portal"');
  });
});
