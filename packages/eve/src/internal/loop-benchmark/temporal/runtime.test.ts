import { describe, expect, it, vi } from "vitest";

import type { TestWorkflowEnvironment } from "@temporalio/testing";

import { LocalTemporalBenchmarkRuntime } from "./runtime.js";
import { LocalTemporalBenchmarkService } from "./service.js";

describe("LocalTemporalBenchmarkRuntime", () => {
  it("rejects new work after its Worker stops", async () => {
    const failure = new Error("worker failed");
    const worker = {
      options: { taskQueue: "test-task-queue" },
      run: () => Promise.reject(failure),
      shutdown: vi.fn(),
    };
    const runtime = new LocalTemporalBenchmarkRuntime({
      compiledArtifactsSource: { kind: "bundled" },
      environment: {} as TestWorkflowEnvironment,
      service: new LocalTemporalBenchmarkService(),
      worker,
    });
    await Promise.resolve();

    await expect(
      runtime.deliver({
        continuationToken: "missing",
        payload: { message: "hello" },
      }),
    ).rejects.toThrow("Local Temporal benchmark Worker stopped.");
  });
});
