import { randomUUID } from "node:crypto";

import type { BenchmarkModelKind } from "../model-kind.js";
import type { BenchmarkSummaryRecord } from "./types.js";
import type { ParsedRunnerConfig } from "./config.js";
import { writeJsonlRecord } from "./jsonl.js";
import { LocalRuntimeServerGroup } from "./local-servers.js";
import { runBenchmarkMatrix, type BenchmarkMatrixDependencies } from "./matrix.js";
import {
  SandboxRuntimeServerGroup,
  type SandboxRuntimeServerGroupHandle,
  type SandboxSetupRecord,
} from "./sandbox-servers.js";
import { readServerTelemetry } from "./server-telemetry.js";
import type { BenchmarkRuntimeKind } from "../driver/index.js";
import type { BenchmarkRuntimeUrls } from "./types.js";

type LocalRunnerConfig = Extract<ParsedRunnerConfig, { readonly mode: "local" }>;
type HostedRunnerConfig = Extract<ParsedRunnerConfig, { readonly mode: "hosted" }>;
type SandboxRunnerConfig = Extract<ParsedRunnerConfig, { readonly mode: "sandbox" }>;

export interface LocalBenchmarkCommandDependencies {
  readonly createRunId: () => string;
  readonly runMatrix: typeof runBenchmarkMatrix;
  readonly serverGroup: LocalRuntimeServerGroup;
  readonly writeRecord: (record: LocalSetupRecord) => void;
}

export interface LocalSetupRecord {
  readonly arch: string;
  readonly kind: "setup";
  readonly modelKind: BenchmarkModelKind;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly runId: string;
  readonly runtimeUrls: BenchmarkRuntimeUrls;
  readonly targetKind: "local";
  readonly topology: "local-processes";
}

export interface HostedBenchmarkCommandDependencies {
  readonly createRunId: () => string;
  readonly runMatrix: typeof runBenchmarkMatrix;
}

export interface SandboxBenchmarkCommandDependencies {
  readonly createRunId: () => string;
  readonly runMatrix: typeof runBenchmarkMatrix;
  readonly serverGroup: SandboxRuntimeServerGroupHandle;
  readonly writeRecord: (record: SandboxSetupRecord) => void;
}

export async function runLocalBenchmarkCommand(
  config: LocalRunnerConfig,
  dependencies: LocalBenchmarkCommandDependencies = {
    createRunId: randomUUID,
    runMatrix: runBenchmarkMatrix,
    serverGroup: new LocalRuntimeServerGroup(),
    writeRecord: writeJsonlRecord,
  },
): Promise<BenchmarkSummaryRecord> {
  try {
    const runtimeUrls = await dependencies.serverGroup.start(config.modelKind);
    const runId = dependencies.createRunId();
    dependencies.writeRecord({
      arch: process.arch,
      kind: "setup",
      modelKind: config.modelKind,
      nodeVersion: process.version,
      platform: process.platform,
      runId,
      runtimeUrls,
      targetKind: "local",
      topology: "local-processes",
    });
    return await dependencies.runMatrix(
      {
        measuredBlocks: config.measuredBlocks,
        modelKind: config.modelKind,
        runId,
        runtimeUrls,
        seed: config.seed,
        targetKind: "local",
        warmupBlocks: config.warmupBlocks,
      },
      {
        collectServerTelemetry: createServerTelemetryCollector(
          async (runtimeKind) => await dependencies.serverGroup.readRecordFile(runtimeKind),
        ),
      },
    );
  } finally {
    await dependencies.serverGroup.stop();
  }
}

export async function runHostedBenchmarkCommand(
  config: HostedRunnerConfig,
  dependencies: HostedBenchmarkCommandDependencies = {
    createRunId: randomUUID,
    runMatrix: runBenchmarkMatrix,
  },
): Promise<BenchmarkSummaryRecord> {
  return await dependencies.runMatrix({
    measuredBlocks: config.measuredBlocks,
    modelKind: config.modelKind,
    runId: dependencies.createRunId(),
    runtimeUrls: config.runtimeUrls,
    seed: config.seed,
    targetKind: "vercel",
    warmupBlocks: config.warmupBlocks,
  });
}

export async function runSandboxBenchmarkCommand(
  config: SandboxRunnerConfig,
  dependencies: SandboxBenchmarkCommandDependencies = {
    createRunId: randomUUID,
    runMatrix: runBenchmarkMatrix,
    serverGroup: new SandboxRuntimeServerGroup(),
    writeRecord: writeJsonlRecord,
  },
): Promise<BenchmarkSummaryRecord> {
  try {
    const { runtimeUrls, sandbox } = await dependencies.serverGroup.start(config);
    const runId = dependencies.createRunId();
    dependencies.writeRecord({
      gitRevision: config.gitRevision,
      kind: "setup",
      modelKind: config.modelKind,
      runId,
      runtimeUrls,
      sandbox,
      targetKind: "vercel",
      topology: "vercel-sandbox",
    });
    return await dependencies.runMatrix(
      {
        measuredBlocks: config.measuredBlocks,
        modelKind: config.modelKind,
        runId,
        runtimeUrls,
        seed: config.seed,
        targetKind: "vercel",
        warmupBlocks: config.warmupBlocks,
      },
      {
        collectServerTelemetry: createServerTelemetryCollector(async (runtimeKind) => {
          return (await dependencies.serverGroup.readRecordFile(runtimeKind)) ?? undefined;
        }),
      },
    );
  } finally {
    await dependencies.serverGroup.stop();
  }
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
