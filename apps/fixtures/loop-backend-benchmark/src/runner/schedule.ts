import type { BenchmarkRuntimeKind } from "../driver/index.js";
import {
  BENCHMARK_RUNTIMES,
  type BenchmarkScheduleEntry,
  type PlannedBenchmarkSample,
  type RuntimeBatch,
} from "./types.js";

export function createBenchmarkSchedule(input: {
  readonly measuredBlocks: number;
  readonly seed: number;
  readonly warmupBlocks: number;
}): readonly BenchmarkScheduleEntry[] {
  const random = createSeededRandom(input.seed);
  const schedule: BenchmarkScheduleEntry[] = [];

  appendBlocks({
    blockCount: input.warmupBlocks,
    phase: "warmup",
    random,
    schedule,
  });
  appendBlocks({
    blockCount: input.measuredBlocks,
    phase: "measured",
    random,
    schedule,
  });

  return schedule;
}

export function createSingleRuntimeSchedule(input: {
  readonly measuredBlocks: number;
  readonly runtimeKind: BenchmarkRuntimeKind;
  readonly warmupBlocks: number;
}): readonly PlannedBenchmarkSample[] {
  const samples: PlannedBenchmarkSample[] = [];

  appendSingleRuntimeBlocks({
    blockCount: input.warmupBlocks,
    phase: "warmup",
    runtimeKind: input.runtimeKind,
    samples,
  });
  appendSingleRuntimeBlocks({
    blockCount: input.measuredBlocks,
    phase: "measured",
    runtimeKind: input.runtimeKind,
    samples,
  });

  return samples;
}

export function createRuntimeBatches(
  schedule: readonly BenchmarkScheduleEntry[],
): readonly RuntimeBatch[] {
  const runtimeOrder = [...new Set(schedule.map((entry) => entry.runtimeKind))];
  const batches: RuntimeBatch[] = [];
  let sampleIndex = 0;

  for (const runtimeKind of runtimeOrder) {
    const batch = createRuntimeBatch(runtimeKind, schedule, sampleIndex);
    batches.push(batch);
    sampleIndex += batch.samples.length;
  }

  return batches;
}

function createRuntimeBatch(
  runtimeKind: BenchmarkRuntimeKind,
  schedule: readonly BenchmarkScheduleEntry[],
  sampleIndex: number,
): RuntimeBatch {
  switch (runtimeKind) {
    case "inline":
      return planRuntimeBatch("inline", schedule, sampleIndex);
    case "workflow":
      return planRuntimeBatch("workflow", schedule, sampleIndex);
    case "temporal":
      return planRuntimeBatch("temporal", schedule, sampleIndex);
    default: {
      const exhaustive: never = runtimeKind;
      return exhaustive;
    }
  }
}

function planRuntimeBatch<K extends BenchmarkRuntimeKind>(
  runtimeKind: K,
  schedule: readonly BenchmarkScheduleEntry[],
  sampleIndex: number,
): {
  readonly runtimeKind: K;
  readonly samples: readonly (PlannedBenchmarkSample & { readonly runtimeKind: K })[];
} {
  const entries = [
    ...schedule.filter((entry) => entry.runtimeKind === runtimeKind && entry.phase === "warmup"),
    ...schedule.filter((entry) => entry.runtimeKind === runtimeKind && entry.phase === "measured"),
  ];
  return {
    runtimeKind,
    samples: entries.map((entry, index) => ({
      ...entry,
      runtimeKind,
      sampleIndex: sampleIndex + index,
    })),
  };
}

function appendSingleRuntimeBlocks(input: {
  readonly blockCount: number;
  readonly phase: BenchmarkScheduleEntry["phase"];
  readonly runtimeKind: BenchmarkRuntimeKind;
  readonly samples: PlannedBenchmarkSample[];
}): void {
  for (let blockIndex = 0; blockIndex < input.blockCount; blockIndex += 1) {
    input.samples.push({
      blockIndex,
      orderInBlock: 0,
      phase: input.phase,
      runtimeKind: input.runtimeKind,
      sampleIndex: input.samples.length,
    });
  }
}

function appendBlocks(input: {
  readonly blockCount: number;
  readonly phase: BenchmarkScheduleEntry["phase"];
  readonly random: () => number;
  readonly schedule: BenchmarkScheduleEntry[];
}): void {
  for (let blockIndex = 0; blockIndex < input.blockCount; blockIndex += 1) {
    const runtimes = shuffleRuntimes(input.random);
    runtimes.forEach((runtimeKind, orderInBlock) => {
      input.schedule.push({
        blockIndex,
        orderInBlock,
        phase: input.phase,
        runtimeKind,
      });
    });
  }
}

function shuffleRuntimes(random: () => number): BenchmarkRuntimeKind[] {
  const runtimes = [...BENCHMARK_RUNTIMES];
  for (let index = runtimes.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = runtimes[index];
    const swap = runtimes[swapIndex];
    if (current === undefined || swap === undefined) {
      throw new Error("The benchmark runtime order is incomplete.");
    }
    runtimes[index] = swap;
    runtimes[swapIndex] = current;
  }
  return runtimes;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
