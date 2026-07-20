import { randomUUID } from "node:crypto";

import { runBenchmarkSample, type BenchmarkRuntimeKind } from "../driver/index.js";
import type { BenchmarkModelKind } from "../model-kind.js";
import type {
  BenchmarkJsonlRecord,
  BenchmarkRunConfig,
  BenchmarkSampleRecord,
  BenchmarkSummaryRecord,
} from "./types.js";
import type { ParsedRunnerConfig } from "./config.js";
import { writeJsonlRecord } from "./jsonl.js";
import { LocalRuntimeServerHost } from "./local-servers.js";
import {
  completeBenchmarkRun,
  executeBenchmarkSamples,
  type BenchmarkMatrixDependencies,
} from "./matrix.js";
import {
  createBenchmarkSchedule,
  createRuntimeBatches,
  createSingleRuntimeSchedule,
} from "./schedule.js";
import {
  SandboxRuntimeServerHost,
  type SandboxRuntimeServerHostHandle,
  type SandboxSetupRecord,
} from "./sandbox-servers.js";
import { readServerTelemetry } from "./server-telemetry.js";

type LocalRunnerConfig = Extract<ParsedRunnerConfig, { readonly mode: "local" }>;
type HostedRunnerConfig = Extract<ParsedRunnerConfig, { readonly mode: "hosted" }>;
type SandboxRunnerConfig = Extract<ParsedRunnerConfig, { readonly mode: "sandbox" }>;

export interface LocalBenchmarkCommandDependencies {
  readonly completeRun: typeof completeBenchmarkRun;
  readonly createRunId: () => string;
  readonly executeSamples: typeof executeBenchmarkSamples;
  readonly serverHost: LocalRuntimeServerHost;
  readonly writeRecord: (record: LocalSetupRecord | BenchmarkJsonlRecord) => void;
}

export interface LocalSetupRecord {
  readonly arch: string;
  readonly kind: "setup";
  readonly modelKind: BenchmarkModelKind;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly runId: string;
  readonly maxConcurrentRuntimeServers: 1;
  readonly runtimeBatchOrder: readonly BenchmarkRuntimeKind[];
  readonly runtimeReuse: "one-process-per-runtime";
  readonly targetKind: "local";
  readonly topology: "local-runtime-batches";
}

export interface HostedBenchmarkCommandDependencies {
  readonly createRunId: () => string;
  readonly runSample: typeof runBenchmarkSample;
  readonly writeRecord: (record: BenchmarkJsonlRecord) => void;
}

export interface SandboxBenchmarkCommandDependencies {
  readonly completeRun: typeof completeBenchmarkRun;
  readonly createRunId: () => string;
  readonly executeSamples: typeof executeBenchmarkSamples;
  readonly serverHost: SandboxRuntimeServerHostHandle;
  readonly writeRecord: (record: SandboxSetupRecord | BenchmarkJsonlRecord) => void;
}

export async function runLocalBenchmarkCommand(
  config: LocalRunnerConfig,
  dependencies: LocalBenchmarkCommandDependencies = {
    completeRun: completeBenchmarkRun,
    createRunId: randomUUID,
    executeSamples: executeBenchmarkSamples,
    serverHost: new LocalRuntimeServerHost(),
    writeRecord: writeJsonlRecord,
  },
): Promise<BenchmarkSummaryRecord> {
  const runId = dependencies.createRunId();
  const runConfig = {
    measuredBlocks: config.measuredBlocks,
    modelKind: config.modelKind,
    runId,
    seed: config.seed,
    targetKind: "local" as const,
    warmupBlocks: config.warmupBlocks,
  };
  const batches = createRuntimeBatches(createBenchmarkSchedule(config));
  const samples: BenchmarkSampleRecord[] = [];

  dependencies.writeRecord({
    arch: process.arch,
    kind: "setup",
    maxConcurrentRuntimeServers: 1,
    modelKind: config.modelKind,
    nodeVersion: process.version,
    platform: process.platform,
    runId,
    runtimeBatchOrder: batches.map((batch) => batch.runtimeKind),
    runtimeReuse: "one-process-per-runtime",
    targetKind: "local",
    topology: "local-runtime-batches",
  });

  for (const batch of batches) {
    const lease = await dependencies.serverHost.acquire(batch.runtimeKind, config.modelKind);
    const batchSamples = await runWithCleanup(
      async () =>
        await dependencies.executeSamples(
          {
            config: runConfig,
            samples: batch.samples.map((sample) => ({ ...sample, targetUrl: lease.targetUrl })),
          },
          {
            collectServerTelemetry: createServerTelemetryCollector(
              async () => await lease.readRecordFile(),
            ),
            writeRecord: dependencies.writeRecord,
          },
        ),
      async () => await lease.stop(),
      `The ${batch.runtimeKind} local benchmark batch failed and server cleanup also failed.`,
    );
    samples.push(...batchSamples);
  }

  return dependencies.completeRun({ config: runConfig, samples }, dependencies.writeRecord);
}

export async function runHostedBenchmarkCommand(
  config: HostedRunnerConfig,
  dependencies: HostedBenchmarkCommandDependencies = {
    createRunId: randomUUID,
    runSample: runBenchmarkSample,
    writeRecord: writeJsonlRecord,
  },
): Promise<BenchmarkSummaryRecord> {
  const runConfig = {
    measuredBlocks: config.measuredBlocks,
    modelKind: config.modelKind,
    runId: dependencies.createRunId(),
    seed: null,
    targetKind: "vercel",
    warmupBlocks: config.warmupBlocks,
  } satisfies BenchmarkRunConfig;
  const samples = await executeBenchmarkSamples(
    {
      config: runConfig,
      samples: createSingleRuntimeSchedule(config).map((sample) => ({
        ...sample,
        targetUrl: config.targetUrl,
      })),
    },
    {
      collectServerTelemetry: async () => ({
        rawRecords: [],
        status: "unavailable",
        summedIntervalDurationsMsByName: {},
      }),
      runSample: async (input) =>
        await dependencies.runSample(input, { vercelOidcToken: config.vercelOidcToken }),
      writeRecord: dependencies.writeRecord,
    },
  );

  return completeBenchmarkRun({ config: runConfig, samples }, dependencies.writeRecord);
}

export async function runSandboxBenchmarkCommand(
  config: SandboxRunnerConfig,
  dependencies: SandboxBenchmarkCommandDependencies = {
    completeRun: completeBenchmarkRun,
    createRunId: randomUUID,
    executeSamples: executeBenchmarkSamples,
    serverHost: new SandboxRuntimeServerHost(),
    writeRecord: writeJsonlRecord,
  },
): Promise<BenchmarkSummaryRecord> {
  const runId = dependencies.createRunId();
  const runConfig = {
    measuredBlocks: config.measuredBlocks,
    modelKind: config.modelKind,
    runId,
    seed: config.seed,
    targetKind: "vercel" as const,
    warmupBlocks: config.warmupBlocks,
  };
  const batches = createRuntimeBatches(createBenchmarkSchedule(config));
  const samples: BenchmarkSampleRecord[] = [];

  return await runWithCleanup(
    async () => {
      const sandbox = await dependencies.serverHost.prepare(config);
      dependencies.writeRecord({
        gitRevision: config.gitRevision,
        kind: "setup",
        maxConcurrentRuntimeServers: 1,
        modelKind: config.modelKind,
        runId,
        runtimeBatchOrder: batches.map((batch) => batch.runtimeKind),
        runtimeReuse: "one-process-per-runtime",
        sandbox,
        sandboxReuse: "one-sandbox-per-run",
        targetKind: "vercel",
        topology: "vercel-sandbox-runtime-batches",
      });

      for (const batch of batches) {
        const lease = await dependencies.serverHost.acquire(batch.runtimeKind);
        const batchSamples = await runWithCleanup(
          async () =>
            await dependencies.executeSamples(
              {
                config: runConfig,
                samples: batch.samples.map((sample) => ({
                  ...sample,
                  targetUrl: lease.targetUrl,
                })),
              },
              {
                collectServerTelemetry: createServerTelemetryCollector(
                  async () => (await lease.readRecordFile()) ?? undefined,
                ),
                runSample: async (input) =>
                  await runBenchmarkSample(input, {
                    vercelOidcToken: config.vercelOidc.token,
                  }),
                writeRecord: dependencies.writeRecord,
              },
            ),
          async () => await lease.stop(),
          `The ${batch.runtimeKind} Sandbox benchmark batch failed and runtime cleanup also failed.`,
        );
        samples.push(...batchSamples);
      }

      return dependencies.completeRun({ config: runConfig, samples }, dependencies.writeRecord);
    },
    async () => await dependencies.serverHost.stop(),
    "The Vercel Sandbox benchmark failed and Sandbox cleanup also failed.",
  );
}

function createServerTelemetryCollector(
  readText: (runtimeKind: BenchmarkRuntimeKind) => Promise<string | undefined>,
): BenchmarkMatrixDependencies["collectServerTelemetry"] {
  return async ({ result, runtimeKind, sampleId }) =>
    await readServerTelemetry({
      expectedRuntime: runtimeKind,
      expectedSampleId: sampleId,
      readText: async () => await readText(runtimeKind),
      waitForPark: result.outcome !== "failed",
    });
}

async function runWithCleanup<Result>(
  operation: () => Promise<Result>,
  cleanup: () => Promise<void>,
  combinedFailureMessage: string,
): Promise<Result> {
  let result: Result;
  try {
    result = await operation();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      const errors = flattenUniqueErrors(error, cleanupError);
      if (errors.length === 1) throw error;
      throw new AggregateError(errors, combinedFailureMessage);
    }
    throw error;
  }

  await cleanup();
  return result;
}

function flattenUniqueErrors(...values: readonly unknown[]): unknown[] {
  const errors: unknown[] = [];
  for (const value of values) {
    const nested = value instanceof AggregateError ? value.errors : [value];
    for (const error of nested) {
      if (!errors.includes(error)) errors.push(error);
    }
  }
  return errors;
}
