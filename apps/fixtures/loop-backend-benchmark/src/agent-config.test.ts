import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("benchmark agent model selection", () => {
  it("rejects an invalid model kind while importing the agent module", async () => {
    vi.stubEnv("EVE_LOOP_BENCHMARK_MODEL_KIND", "invalid");

    await expect(import("../agent/agent.js")).rejects.toThrow(
      'EVE_LOOP_BENCHMARK_MODEL_KIND must be "deterministic" or "live"; received "invalid".',
    );
  });
});
