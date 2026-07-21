import { describe, expect, test } from "vitest";

import { buildComparisonRows } from "./report.js";

const usage = (totalTokens) => ({
  totalTokens,
  totalInputTokens: totalTokens - 10,
  inputTokens: 20,
  cacheCreationInputTokens: 30,
  cacheReadInputTokens: totalTokens - 60,
  outputTokens: 10,
});

describe("buildComparisonRows", () => {
  test("shows reference, current, and signed deltas", () => {
    const summaries = new Map([
      [
        "reference-baseline",
        {
          passed: 1,
          runs: 2,
          accuracy: 50,
          duration: 12,
          usageRuns: 2,
          usage: usage(1_000),
        },
      ],
      [
        "current-baseline",
        {
          passed: 2,
          runs: 2,
          accuracy: 100,
          duration: 10.5,
          usageRuns: 2,
          usage: usage(900),
        },
      ],
    ]);

    expect(buildComparisonRows(["baseline"], summaries)).toEqual([
      [
        "reference",
        "baseline",
        "1/2 (50%)",
        "2/2",
        "1,000",
        "990",
        "20",
        "30",
        "940",
        "10",
        "12.0s",
      ],
      ["current", "baseline", "2/2 (100%)", "2/2", "900", "890", "20", "30", "840", "10", "10.5s"],
      ["Δ", "baseline", "+50 pp", "—", "-100", "-100", "0", "0", "-100", "0", "-1.5s"],
    ]);
  });
});
