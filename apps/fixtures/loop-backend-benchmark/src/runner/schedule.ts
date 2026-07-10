import type { BenchmarkRuntimeKind } from "../driver/index.js";
import { BENCHMARK_RUNTIMES, type BenchmarkScheduleEntry } from "./types.js";

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
