import { describe, expect, it } from "vitest";

import {
  createDeterministicBenchmarkResponse,
  deterministicBenchmarkModel,
} from "./deterministic-model.js";

const BENCHMARK_TOOL = { name: "benchmark_echo" };

describe("deterministicBenchmarkModel", () => {
  it("is a source-backed AI SDK model", () => {
    expect(deterministicBenchmarkModel).toMatchObject({
      modelId: "loop-backend-benchmark",
      provider: "eve-loop-benchmark",
      specificationVersion: "v3",
    });
  });

  it("makes one exact benchmark_echo call for the user nonce", () => {
    expect(
      createDeterministicBenchmarkResponse({
        lastUserMessage: "nonce:exact whitespace ",
        toolResults: [],
        tools: [BENCHMARK_TOOL],
      }),
    ).toEqual({
      toolCalls: [
        {
          id: "benchmark-echo-call",
          input: { nonce: "nonce:exact whitespace " },
          name: "benchmark_echo",
        },
      ],
    });
  });

  it("returns the exact successful tool output", () => {
    expect(
      createDeterministicBenchmarkResponse({
        lastUserMessage: "nonce",
        toolResults: [
          {
            id: "benchmark-echo-call",
            isError: false,
            name: "benchmark_echo",
            output: "benchmark-verified:nonce",
          },
        ],
        tools: [BENCHMARK_TOOL],
      }),
    ).toBe("benchmark-verified:nonce");
  });

  it("rejects requests outside the fixed benchmark protocol", () => {
    expect(() =>
      createDeterministicBenchmarkResponse({
        lastUserMessage: "nonce",
        toolResults: [],
        tools: [],
      }),
    ).toThrow("requires the benchmark_echo tool");
    expect(() =>
      createDeterministicBenchmarkResponse({
        lastUserMessage: "nonce",
        toolResults: [
          {
            id: "benchmark-echo-call",
            isError: true,
            name: "benchmark_echo",
            output: "failed",
          },
        ],
        tools: [BENCHMARK_TOOL],
      }),
    ).toThrow("received a failed benchmark_echo result");
  });
});
