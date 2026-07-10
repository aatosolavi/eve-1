import { describe, expect, it } from "vitest";

import { createBenchmarkSchedule } from "./schedule.js";
import type { BenchmarkPhase } from "./types.js";

describe("createBenchmarkSchedule", () => {
  it("creates seeded randomized complete blocks", () => {
    const first = createBenchmarkSchedule({ measuredBlocks: 12, seed: 42, warmupBlocks: 3 });
    const repeated = createBenchmarkSchedule({ measuredBlocks: 12, seed: 42, warmupBlocks: 3 });
    const otherSeed = createBenchmarkSchedule({ measuredBlocks: 12, seed: 43, warmupBlocks: 3 });

    expect(first).toEqual(repeated);
    expect(first).not.toEqual(otherSeed);
    expect(first).toHaveLength(45);

    const phases: readonly BenchmarkPhase[] = ["warmup", "measured"];
    for (const phase of phases) {
      const entries = first.filter((entry) => entry.phase === phase);
      const blockCount = phase === "warmup" ? 3 : 12;
      for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
        expect(
          entries
            .filter((entry) => entry.blockIndex === blockIndex)
            .map((entry) => entry.runtimeKind)
            .toSorted(),
        ).toEqual(["inline", "temporal", "workflow"]);
      }
    }
  });

  it("allows runs without warmup blocks", () => {
    expect(createBenchmarkSchedule({ measuredBlocks: 1, seed: 0, warmupBlocks: 0 })).toHaveLength(
      3,
    );
  });
});
