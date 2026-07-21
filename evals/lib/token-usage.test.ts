import { describe, expect, test } from "vitest";

import { createResultHook, parseTokenUsage } from "./token-usage.js";

describe("parseTokenUsage", () => {
  test("aggregates usage across coding-agent turns", () => {
    const transcript = [
      JSON.stringify({
        message: {
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 4,
          },
        },
      }),
      JSON.stringify({ type: "tool_result" }),
      JSON.stringify({
        message: {
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 5,
          },
        },
      }),
    ].join("\n");

    expect(parseTokenUsage(transcript)).toEqual({
      inputTokens: 11,
      cacheCreationInputTokens: 22,
      cacheReadInputTokens: 33,
      outputTokens: 9,
      totalInputTokens: 66,
      totalTokens: 75,
    });
  });

  test("returns undefined when the transcript has no usage", () => {
    expect(parseTokenUsage(undefined)).toBeUndefined();
    expect(parseTokenUsage(JSON.stringify({ type: "tool_result" }))).toBeUndefined();
  });

  test("records documentation snapshot metadata without token usage", async () => {
    const metadata = {
      treatment: "agents-md",
      snapshot: "reference" as const,
      gitRef: "origin/main",
      gitSha: "abc123",
      dirty: false,
    };
    const output = await createResultHook(metadata)({
      runData: {
        transcript: undefined,
        result: { analysis: {}, status: "passed" },
      },
    } as never);

    expect(output).toMatchObject({
      result: { analysis: { documentationEval: metadata } },
    });
  });
});
