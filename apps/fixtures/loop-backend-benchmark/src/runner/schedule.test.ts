import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createBenchmarkSchedule,
  createRuntimeBatches,
  createSingleRuntimeSchedule,
} from "./schedule.js";
import type {
  BenchmarkPhase,
  BenchmarkScheduleEntry,
  PlannedBenchmarkSample,
  RuntimeBatch,
} from "./types.js";

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

describe("createRuntimeBatches", () => {
  it("preserves canonical metadata and assigns actual batched sample indices", () => {
    const schedule = createBenchmarkSchedule({ measuredBlocks: 3, seed: 42, warmupBlocks: 2 });
    const batches = createRuntimeBatches(schedule);
    const plannedSamples = flattenPlannedSamples(batches);
    const plannedEntries: BenchmarkScheduleEntry[] = plannedSamples.map(
      ({ sampleIndex: _sampleIndex, ...entry }) => entry,
    );

    expect(batches.map((batch) => batch.runtimeKind)).toEqual([
      ...new Set(schedule.map((entry) => entry.runtimeKind)),
    ]);
    expect(plannedSamples.map((sample) => sample.sampleIndex)).toEqual(
      Array.from({ length: schedule.length }, (_, index) => index),
    );
    expect(plannedEntries).toHaveLength(schedule.length);
    expect(plannedEntries).toEqual(expect.arrayContaining([...schedule]));

    for (const batch of batches) {
      expect(batch.samples.every((sample) => sample.runtimeKind === batch.runtimeKind)).toBe(true);
      expect(batch.samples.map((sample) => sample.phase)).toEqual([
        "warmup",
        "warmup",
        "measured",
        "measured",
        "measured",
      ]);

      switch (batch.runtimeKind) {
        case "inline":
          expectTypeOf(batch.samples).toMatchTypeOf<
            readonly (PlannedBenchmarkSample & { readonly runtimeKind: "inline" })[]
          >();
          break;
        case "workflow":
          expectTypeOf(batch.samples).toMatchTypeOf<
            readonly (PlannedBenchmarkSample & { readonly runtimeKind: "workflow" })[]
          >();
          break;
        case "temporal":
          expectTypeOf(batch.samples).toMatchTypeOf<
            readonly (PlannedBenchmarkSample & { readonly runtimeKind: "temporal" })[]
          >();
          break;
      }
    }
  });

  it("uses first canonical appearance for batch order and puts warmups first", () => {
    const schedule: readonly BenchmarkScheduleEntry[] = [
      { blockIndex: 0, orderInBlock: 0, phase: "measured", runtimeKind: "workflow" },
      { blockIndex: 0, orderInBlock: 1, phase: "warmup", runtimeKind: "inline" },
      { blockIndex: 0, orderInBlock: 2, phase: "measured", runtimeKind: "temporal" },
      { blockIndex: 1, orderInBlock: 0, phase: "warmup", runtimeKind: "workflow" },
      { blockIndex: 1, orderInBlock: 1, phase: "measured", runtimeKind: "inline" },
      { blockIndex: 1, orderInBlock: 2, phase: "warmup", runtimeKind: "temporal" },
    ];

    const batches = createRuntimeBatches(schedule);

    expect(batches.map((batch) => batch.runtimeKind)).toEqual(["workflow", "inline", "temporal"]);
    expect(batches.map((batch) => batch.samples.map((sample) => sample.phase))).toEqual([
      ["warmup", "measured"],
      ["warmup", "measured"],
      ["warmup", "measured"],
    ]);
    expect(flattenPlannedSamples(batches).map((sample) => sample.sampleIndex)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });
});

describe("createSingleRuntimeSchedule", () => {
  it("creates one contiguous runtime lane without matrix ordering metadata", () => {
    expect(
      createSingleRuntimeSchedule({
        measuredBlocks: 2,
        runtimeKind: "workflow",
        warmupBlocks: 1,
      }),
    ).toEqual([
      {
        blockIndex: 0,
        orderInBlock: 0,
        phase: "warmup",
        runtimeKind: "workflow",
        sampleIndex: 0,
      },
      {
        blockIndex: 0,
        orderInBlock: 0,
        phase: "measured",
        runtimeKind: "workflow",
        sampleIndex: 1,
      },
      {
        blockIndex: 1,
        orderInBlock: 0,
        phase: "measured",
        runtimeKind: "workflow",
        sampleIndex: 2,
      },
    ]);
  });
});

function flattenPlannedSamples(batches: readonly RuntimeBatch[]): PlannedBenchmarkSample[] {
  const samples: PlannedBenchmarkSample[] = [];
  for (const batch of batches) samples.push(...batch.samples);
  return samples;
}
