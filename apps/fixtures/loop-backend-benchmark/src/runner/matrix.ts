import {
  runBenchmarkSample,
  type BenchmarkRuntimeKind,
  type BenchmarkSampleResult,
  type RunBenchmarkSampleInput,
} from "../driver/index.js";
import { writeJsonlRecord } from "./jsonl.js";
import { createBenchmarkSchedule } from "./schedule.js";
import type { ServerTelemetryResult } from "./server-telemetry.js";
import { summarizeBenchmarkMatrix } from "./summary.js";
import type {
  BenchmarkJsonlRecord,
  BenchmarkMatrixConfig,
  BenchmarkSampleRecord,
  BenchmarkSummaryRecord,
} from "./types.js";

export interface BenchmarkMatrixDependencies {
  readonly collectServerTelemetry: (
    input: CollectServerTelemetryInput,
  ) => Promise<ServerTelemetryResult>;
  readonly runSample: (input: RunBenchmarkSampleInput) => Promise<BenchmarkSampleResult>;
  readonly writeRecord: (record: BenchmarkJsonlRecord) => void;
}

export interface CollectServerTelemetryInput {
  readonly result: BenchmarkSampleResult;
  readonly runtimeKind: BenchmarkRuntimeKind;
  readonly sampleId: string;
}

const DEFAULT_DEPENDENCIES: BenchmarkMatrixDependencies = {
  collectServerTelemetry: async () => ({
    rawRecords: [],
    status: "unavailable",
    summedIntervalDurationsMsByName: {},
  }),
  runSample: runBenchmarkSample,
  writeRecord: writeJsonlRecord,
};

export async function runBenchmarkMatrix(
  config: BenchmarkMatrixConfig,
  dependencyOverrides: Partial<BenchmarkMatrixDependencies> = {},
): Promise<BenchmarkSummaryRecord> {
  const dependencies: BenchmarkMatrixDependencies = {
    collectServerTelemetry:
      dependencyOverrides.collectServerTelemetry ?? DEFAULT_DEPENDENCIES.collectServerTelemetry,
    runSample: dependencyOverrides.runSample ?? DEFAULT_DEPENDENCIES.runSample,
    writeRecord: dependencyOverrides.writeRecord ?? DEFAULT_DEPENDENCIES.writeRecord,
  };
  const schedule = createBenchmarkSchedule(config);
  const samples: BenchmarkSampleRecord[] = [];

  for (const [sampleIndex, entry] of schedule.entries()) {
    const nonce = createBlockNonce({
      blockIndex: entry.blockIndex,
      phase: entry.phase,
      runId: config.runId,
    });
    const sampleId = createSampleId({
      blockIndex: entry.blockIndex,
      phase: entry.phase,
      runId: config.runId,
      runtimeKind: entry.runtimeKind,
    });
    const result = await dependencies.runSample({
      nonce,
      runtimeKind: entry.runtimeKind,
      sampleId,
      targetKind: config.targetKind,
      targetUrl: runtimeUrl(config, entry.runtimeKind),
    });
    const serverTelemetry = await dependencies.collectServerTelemetry({
      result,
      runtimeKind: entry.runtimeKind,
      sampleId,
    });
    const record: BenchmarkSampleRecord = {
      blockIndex: entry.blockIndex,
      kind: "sample",
      modelKind: config.modelKind,
      orderInBlock: entry.orderInBlock,
      phase: entry.phase,
      result,
      runId: config.runId,
      sampleIndex,
      serverTelemetry,
    };
    samples.push(record);
    dependencies.writeRecord(record);
  }

  const summary = summarizeBenchmarkMatrix({ config, samples });
  dependencies.writeRecord(summary);
  return summary;
}

function runtimeUrl(config: BenchmarkMatrixConfig, runtimeKind: BenchmarkRuntimeKind): string {
  switch (runtimeKind) {
    case "inline":
      return config.runtimeUrls.inline;
    case "temporal":
      return config.runtimeUrls.temporal;
    case "workflow":
      return config.runtimeUrls.workflow;
    default: {
      const exhaustive: never = runtimeKind;
      return exhaustive;
    }
  }
}

function createBlockNonce(input: {
  readonly blockIndex: number;
  readonly phase: BenchmarkSampleRecord["phase"];
  readonly runId: string;
}): string {
  return `${input.runId}:nonce:${input.phase}:${input.blockIndex}`;
}

function createSampleId(input: {
  readonly blockIndex: number;
  readonly phase: BenchmarkSampleRecord["phase"];
  readonly runId: string;
  readonly runtimeKind: BenchmarkRuntimeKind;
}): string {
  return `${input.runId}:${input.phase}:${input.blockIndex}:${input.runtimeKind}`;
}
