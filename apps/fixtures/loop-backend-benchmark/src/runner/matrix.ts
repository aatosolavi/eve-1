import {
  runBenchmarkSample,
  type BenchmarkRuntimeKind,
  type BenchmarkSampleResult,
  type RunBenchmarkSampleInput,
} from "../driver/index.js";
import { writeJsonlRecord } from "./jsonl.js";
import type { ServerTelemetryResult } from "./server-telemetry.js";
import { summarizeBenchmarkMatrix } from "./summary.js";
import type {
  BenchmarkExecutionSample,
  BenchmarkJsonlRecord,
  BenchmarkRunConfig,
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

export async function executeBenchmarkSamples(
  input: {
    readonly config: BenchmarkRunConfig;
    readonly samples: readonly BenchmarkExecutionSample[];
  },
  dependencyOverrides: Partial<BenchmarkMatrixDependencies> = {},
): Promise<readonly BenchmarkSampleRecord[]> {
  const dependencies = resolveDependencies(dependencyOverrides);
  const samples: BenchmarkSampleRecord[] = [];

  for (const sample of input.samples) {
    const nonce = createBlockNonce({
      blockIndex: sample.blockIndex,
      phase: sample.phase,
      runId: input.config.runId,
    });
    const sampleId = createSampleId({
      blockIndex: sample.blockIndex,
      phase: sample.phase,
      runId: input.config.runId,
      runtimeKind: sample.runtimeKind,
    });
    const result = await dependencies.runSample({
      nonce,
      runtimeKind: sample.runtimeKind,
      sampleId,
      targetKind: input.config.targetKind,
      targetUrl: sample.targetUrl,
    });
    const serverTelemetry = await dependencies.collectServerTelemetry({
      result,
      runtimeKind: sample.runtimeKind,
      sampleId,
    });
    const record: BenchmarkSampleRecord = {
      blockIndex: sample.blockIndex,
      kind: "sample",
      modelKind: input.config.modelKind,
      orderInBlock: sample.orderInBlock,
      phase: sample.phase,
      result,
      runId: input.config.runId,
      sampleIndex: sample.sampleIndex,
      serverTelemetry,
    };
    samples.push(record);
    dependencies.writeRecord(record);
  }

  return samples;
}

export function completeBenchmarkRun(
  input: {
    readonly config: BenchmarkRunConfig;
    readonly samples: readonly BenchmarkSampleRecord[];
  },
  writeRecord: (record: BenchmarkJsonlRecord) => void,
): BenchmarkSummaryRecord {
  const summary = summarizeBenchmarkMatrix(input);
  writeRecord(summary);
  return summary;
}

function resolveDependencies(
  dependencyOverrides: Partial<BenchmarkMatrixDependencies>,
): BenchmarkMatrixDependencies {
  return {
    collectServerTelemetry:
      dependencyOverrides.collectServerTelemetry ?? DEFAULT_DEPENDENCIES.collectServerTelemetry,
    runSample: dependencyOverrides.runSample ?? DEFAULT_DEPENDENCIES.runSample,
    writeRecord: dependencyOverrides.writeRecord ?? DEFAULT_DEPENDENCIES.writeRecord,
  };
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
