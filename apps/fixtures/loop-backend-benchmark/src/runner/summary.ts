import type {
  BenchmarkRuntimeKind,
  BenchmarkSampleResult,
  CompletedBenchmarkMeasurements,
} from "../driver/index.js";
import type {
  BenchmarkMatrixConfig,
  BenchmarkOutcomeCounts,
  BenchmarkSampleRecord,
  BenchmarkSummaryRecord,
  ClientMetricSummary,
  IntervalDurationSummary,
  PercentileSummary,
  RuntimeServerTelemetryStatusCounts,
  ServerTelemetryStatusCounts,
} from "./types.js";

type ClientMetricName = Exclude<keyof CompletedBenchmarkMeasurements, "events">;
type ValidBenchmarkSampleResult = Extract<BenchmarkSampleResult, { readonly outcome: "valid" }>;

export function summarizeBenchmarkMatrix(input: {
  readonly config: BenchmarkMatrixConfig;
  readonly samples: readonly BenchmarkSampleRecord[];
}): BenchmarkSummaryRecord {
  const measuredSamples = input.samples.filter((sample) => sample.phase === "measured");
  const warmupSamples = input.samples.filter((sample) => sample.phase === "warmup");

  return {
    blocks: {
      measured: input.config.measuredBlocks,
      warmup: input.config.warmupBlocks,
    },
    correctness: {
      measured: summarizeOutcomes(measuredSamples),
      warmup: summarizeOutcomes(warmupSamples),
    },
    kind: "summary",
    measuredClientMetrics: {
      inline: summarizeRuntimeMetrics(measuredSamples, "inline"),
      temporal: summarizeRuntimeMetrics(measuredSamples, "temporal"),
      workflow: summarizeRuntimeMetrics(measuredSamples, "workflow"),
    },
    modelKind: input.config.modelKind,
    pairedMeasuredClientDifferences: {
      "temporal-minus-inline": summarizePairedDifferences(measuredSamples, "temporal", "inline"),
      "temporal-minus-workflow": summarizePairedDifferences(
        measuredSamples,
        "temporal",
        "workflow",
      ),
      "workflow-minus-inline": summarizePairedDifferences(measuredSamples, "workflow", "inline"),
    },
    runId: input.config.runId,
    seed: input.config.seed,
    serverTelemetry: {
      measuredSummedIntervalDurationsMsByName: {
        inline: summarizeRuntimeIntervalDurations(measuredSamples, "inline"),
        temporal: summarizeRuntimeIntervalDurations(measuredSamples, "temporal"),
        workflow: summarizeRuntimeIntervalDurations(measuredSamples, "workflow"),
      },
      pairedMeasuredSummedIntervalDurationDifferencesMsByName: {
        "temporal-minus-inline": summarizePairedIntervalDifferences(
          measuredSamples,
          "temporal",
          "inline",
        ),
        "temporal-minus-workflow": summarizePairedIntervalDifferences(
          measuredSamples,
          "temporal",
          "workflow",
        ),
        "workflow-minus-inline": summarizePairedIntervalDifferences(
          measuredSamples,
          "workflow",
          "inline",
        ),
      },
      statusCounts: {
        measured: summarizeTelemetryStatuses(measuredSamples),
        warmup: summarizeTelemetryStatuses(warmupSamples),
      },
    },
    targetKind: input.config.targetKind,
  };
}

export function calculatePercentiles(values: readonly number[]): PercentileSummary | null {
  if (values.length === 0) return null;

  const sorted = values.toSorted((left, right) => left - right);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
    p95: nearestRank(sorted, 0.95),
  };
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("Cannot calculate a percentile from an empty sample.");
  }
  return value;
}

function summarizeOutcomes(samples: readonly BenchmarkSampleRecord[]) {
  return {
    inline: countRuntimeOutcomes(samples, "inline"),
    temporal: countRuntimeOutcomes(samples, "temporal"),
    workflow: countRuntimeOutcomes(samples, "workflow"),
  };
}

function countRuntimeOutcomes(
  samples: readonly BenchmarkSampleRecord[],
  runtimeKind: BenchmarkRuntimeKind,
): BenchmarkOutcomeCounts {
  const runtimeSamples = samples.filter((sample) => sample.result.runtimeKind === runtimeKind);
  return {
    failed: runtimeSamples.filter((sample) => sample.result.outcome === "failed").length,
    invalid: runtimeSamples.filter((sample) => sample.result.outcome === "invalid").length,
    valid: runtimeSamples.filter((sample) => sample.result.outcome === "valid").length,
  };
}

function summarizeTelemetryStatuses(
  samples: readonly BenchmarkSampleRecord[],
): RuntimeServerTelemetryStatusCounts {
  return {
    inline: countTelemetryStatuses(samples, "inline"),
    temporal: countTelemetryStatuses(samples, "temporal"),
    workflow: countTelemetryStatuses(samples, "workflow"),
  };
}

function countTelemetryStatuses(
  samples: readonly BenchmarkSampleRecord[],
  runtimeKind: BenchmarkRuntimeKind,
): ServerTelemetryStatusCounts {
  const runtimeSamples = samples.filter((sample) => sample.result.runtimeKind === runtimeKind);
  return {
    complete: runtimeSamples.filter((sample) => sample.serverTelemetry.status === "complete")
      .length,
    failed: runtimeSamples.filter((sample) => sample.serverTelemetry.status === "failed").length,
    incomplete: runtimeSamples.filter((sample) => sample.serverTelemetry.status === "incomplete")
      .length,
    unavailable: runtimeSamples.filter((sample) => sample.serverTelemetry.status === "unavailable")
      .length,
  };
}

function summarizeRuntimeMetrics(
  samples: readonly BenchmarkSampleRecord[],
  runtimeKind: BenchmarkRuntimeKind,
): ClientMetricSummary {
  const results = samples
    .filter((sample) => sample.result.runtimeKind === runtimeKind)
    .map((sample) => sample.result)
    .filter(isValidResult);
  return summarizeMetrics((metric) =>
    results.flatMap((result) => {
      const value = readMetric(result, metric);
      return value === null ? [] : [value];
    }),
  );
}

function summarizeRuntimeIntervalDurations(
  samples: readonly BenchmarkSampleRecord[],
  runtimeKind: BenchmarkRuntimeKind,
): IntervalDurationSummary {
  const values = new Map<string, number[]>();
  for (const sample of samples) {
    if (
      sample.result.runtimeKind !== runtimeKind ||
      !isValidResult(sample.result) ||
      sample.serverTelemetry.status !== "complete"
    ) {
      continue;
    }
    appendIntervalValues(values, sample.serverTelemetry.summedIntervalDurationsMsByName);
  }
  return summarizeNamedValues(values);
}

function summarizePairedIntervalDifferences(
  samples: readonly BenchmarkSampleRecord[],
  leftRuntime: BenchmarkRuntimeKind,
  rightRuntime: BenchmarkRuntimeKind,
): IntervalDurationSummary {
  const leftByBlock = validCompleteSamplesByBlock(samples, leftRuntime);
  const rightByBlock = validCompleteSamplesByBlock(samples, rightRuntime);
  const differences = new Map<string, number[]>();

  for (const [blockIndex, left] of leftByBlock) {
    const right = rightByBlock.get(blockIndex);
    if (right === undefined) continue;

    for (const [name, leftDuration] of Object.entries(
      left.serverTelemetry.summedIntervalDurationsMsByName,
    )) {
      const rightDuration = right.serverTelemetry.summedIntervalDurationsMsByName[name];
      if (rightDuration === undefined) continue;
      appendNamedValue(differences, name, leftDuration - rightDuration);
    }
  }
  return summarizeNamedValues(differences);
}

function validCompleteSamplesByBlock(
  samples: readonly BenchmarkSampleRecord[],
  runtimeKind: BenchmarkRuntimeKind,
): ReadonlyMap<number, BenchmarkSampleRecord> {
  const results = new Map<number, BenchmarkSampleRecord>();
  for (const sample of samples) {
    if (
      sample.result.runtimeKind === runtimeKind &&
      isValidResult(sample.result) &&
      sample.serverTelemetry.status === "complete"
    ) {
      results.set(sample.blockIndex, sample);
    }
  }
  return results;
}

function appendIntervalValues(
  target: Map<string, number[]>,
  values: Readonly<Record<string, number>>,
): void {
  for (const [name, value] of Object.entries(values)) appendNamedValue(target, name, value);
}

function appendNamedValue(target: Map<string, number[]>, name: string, value: number): void {
  const values = target.get(name);
  if (values === undefined) {
    target.set(name, [value]);
  } else {
    values.push(value);
  }
}

function summarizeNamedValues(
  values: ReadonlyMap<string, readonly number[]>,
): IntervalDurationSummary {
  return Object.fromEntries(
    [...values]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, samples]) => {
        const summary = calculatePercentiles(samples);
        return summary === null ? [] : [[name, summary]];
      }),
  );
}

function summarizePairedDifferences(
  samples: readonly BenchmarkSampleRecord[],
  leftRuntime: BenchmarkRuntimeKind,
  rightRuntime: BenchmarkRuntimeKind,
): ClientMetricSummary {
  const leftByBlock = validResultsByBlock(samples, leftRuntime);
  const rightByBlock = validResultsByBlock(samples, rightRuntime);

  return summarizeMetrics((metric) => {
    const differences: number[] = [];
    for (const [blockIndex, left] of leftByBlock) {
      const right = rightByBlock.get(blockIndex);
      if (right === undefined) continue;

      const leftValue = readMetric(left, metric);
      const rightValue = readMetric(right, metric);
      if (leftValue !== null && rightValue !== null) {
        differences.push(leftValue - rightValue);
      }
    }
    return differences;
  });
}

function validResultsByBlock(
  samples: readonly BenchmarkSampleRecord[],
  runtimeKind: BenchmarkRuntimeKind,
): ReadonlyMap<number, ValidBenchmarkSampleResult> {
  const results = new Map<number, ValidBenchmarkSampleResult>();
  for (const sample of samples) {
    if (sample.result.runtimeKind === runtimeKind && isValidResult(sample.result)) {
      results.set(sample.blockIndex, sample.result);
    }
  }
  return results;
}

function summarizeMetrics(
  values: (metric: ClientMetricName) => readonly number[],
): ClientMetricSummary {
  return {
    firstDecodedEventMs: calculatePercentiles(values("firstDecodedEventMs")),
    firstTextEventReceivedToStopStepCompletedMs: calculatePercentiles(
      values("firstTextEventReceivedToStopStepCompletedMs"),
    ),
    firstVisibleTextMs: calculatePercentiles(values("firstVisibleTextMs")),
    postAckMs: calculatePercentiles(values("postAckMs")),
    postAckToSessionStartedEventReceivedMs: calculatePercentiles(
      values("postAckToSessionStartedEventReceivedMs"),
    ),
    reducerTotalMs: calculatePercentiles(values("reducerTotalMs")),
    sessionStartedToToolRequestEventReceivedMs: calculatePercentiles(
      values("sessionStartedToToolRequestEventReceivedMs"),
    ),
    sessionWaitingEventReceivedMs: calculatePercentiles(values("sessionWaitingEventReceivedMs")),
    sessionWaitingReducedMs: calculatePercentiles(values("sessionWaitingReducedMs")),
    stopStepCompletedToSessionWaitingEventReceivedMs: calculatePercentiles(
      values("stopStepCompletedToSessionWaitingEventReceivedMs"),
    ),
    toolRequestToToolStepCompletedEventReceivedMs: calculatePercentiles(
      values("toolRequestToToolStepCompletedEventReceivedMs"),
    ),
    toolStepCompletedToFirstTextEventReceivedMs: calculatePercentiles(
      values("toolStepCompletedToFirstTextEventReceivedMs"),
    ),
  };
}

function readMetric(result: ValidBenchmarkSampleResult, metric: ClientMetricName): number | null {
  return result.measurements[metric];
}

function isValidResult(result: BenchmarkSampleResult): result is ValidBenchmarkSampleResult {
  return result.outcome === "valid";
}
