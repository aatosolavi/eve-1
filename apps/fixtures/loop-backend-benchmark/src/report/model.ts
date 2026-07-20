import { z } from "zod";

import type { BenchmarkSummaryRecord, PercentileSummary } from "../runner/types.js";

const runtimeSchema = z.enum(["inline", "workflow", "temporal"]);
const modelKindSchema = z.enum(["deterministic", "live"]);
const targetKindSchema = z.enum(["local", "vercel"]);
const topologySchema = z.enum(["local-runtime-batches", "vercel-sandbox-runtime-batches"]);
const protocolPhaseSchema = z.enum([
  "postAckMs",
  "postAckToSessionStartedEventReceivedMs",
  "sessionStartedToToolRequestEventReceivedMs",
  "toolRequestToToolStepCompletedEventReceivedMs",
  "toolStepCompletedToFirstTextEventReceivedMs",
  "firstTextEventReceivedToStopStepCompletedMs",
  "stopStepCompletedToSessionWaitingEventReceivedMs",
]);
const comparisonSchema = z.enum(["workflow-minus-inline", "temporal-minus-inline"]);

/** Runtime implementations rendered by the benchmark report. */
export type BenchmarkReportRuntime = z.infer<typeof runtimeSchema>;

/** Stable display order for runtime implementations. */
export const BENCHMARK_REPORT_RUNTIMES: readonly BenchmarkReportRuntime[] = [
  "inline",
  "workflow",
  "temporal",
];

/** One additive client-observed phase from request start through `session.waiting`. */
export type BenchmarkReportProtocolPhase = z.infer<typeof protocolPhaseSchema>;

/** Stable request-to-waiting order for the seven additive protocol phases. */
export const BENCHMARK_REPORT_PROTOCOL_PHASES: readonly BenchmarkReportProtocolPhase[] = [
  "postAckMs",
  "postAckToSessionStartedEventReceivedMs",
  "sessionStartedToToolRequestEventReceivedMs",
  "toolRequestToToolStepCompletedEventReceivedMs",
  "toolStepCompletedToFirstTextEventReceivedMs",
  "firstTextEventReceivedToStopStepCompletedMs",
  "stopStepCompletedToSessionWaitingEventReceivedMs",
];

/** Runtime-minus-inline comparisons retained by the report. */
export type BenchmarkReportComparison = z.infer<typeof comparisonSchema>;

/** Stable display order for paired runtime overhead comparisons. */
export const BENCHMARK_REPORT_COMPARISONS: readonly BenchmarkReportComparison[] = [
  "workflow-minus-inline",
  "temporal-minus-inline",
];

/** One named JSONL document supplied to the report parser. */
export interface BenchmarkReportInput {
  readonly label: string;
  readonly text: string;
}

/** Nearest-rank percentile summary copied from the benchmark summary record. */
export type BenchmarkReportPercentiles = PercentileSummary;

/** Correctness counts copied from the benchmark summary record. */
export type BenchmarkReportCorrectness = BenchmarkSummaryRecord["correctness"];

/** Server telemetry collection counts copied from the benchmark summary record. */
export type BenchmarkReportTelemetryStatusCounts =
  BenchmarkSummaryRecord["serverTelemetry"]["statusCounts"];

/** Runtime metrics needed by the latency, layercake, and server-interval plots. */
export interface BenchmarkReportRuntimeMetrics {
  readonly e2eSessionWaitingReducedMs: BenchmarkReportPercentiles | null;
  readonly firstVisibleTextMs: BenchmarkReportPercentiles | null;
  readonly measuredValidSampleCount: number;
  readonly protocolPhaseMeansMs: Readonly<Record<BenchmarkReportProtocolPhase, number | null>>;
  readonly protocolPhasePercentilesMs: Readonly<
    Record<BenchmarkReportProtocolPhase, BenchmarkReportPercentiles | null>
  >;
  readonly serverIntervalPercentilesMsByName: Readonly<Record<string, BenchmarkReportPercentiles>>;
}

/** Paired client and server deltas for one runtime-minus-inline comparison. */
export interface BenchmarkReportPairedMetrics {
  readonly e2eSessionWaitingReducedMs: BenchmarkReportPercentiles | null;
  readonly serverIntervalPercentilesMsByName: Readonly<Record<string, BenchmarkReportPercentiles>>;
}

/** One independently rendered benchmark run. */
export interface BenchmarkReportRun {
  readonly comparisons: Readonly<Record<BenchmarkReportComparison, BenchmarkReportPairedMetrics>>;
  readonly correctness: BenchmarkReportCorrectness;
  readonly modelKind: z.infer<typeof modelKindSchema>;
  readonly runId: string;
  readonly runtimes: Readonly<Record<BenchmarkReportRuntime, BenchmarkReportRuntimeMetrics>>;
  readonly sourceLabels: readonly string[];
  readonly targetKind: z.infer<typeof targetKindSchema>;
  readonly telemetryStatusCounts: BenchmarkReportTelemetryStatusCounts;
  /** `null` identifies a run whose JSONL stream contained no setup record, such as hosted mode. */
  readonly topology: z.infer<typeof topologySchema> | null;
}

/** Compact, visualization-ready model containing independent benchmark runs. */
export interface BenchmarkReportModel {
  readonly runs: readonly BenchmarkReportRun[];
}

const identifierSchema = z.string().trim().min(1);
const durationSchema = z.number().finite().nonnegative();
const percentileSchema = z.object({
  count: z.number().int().positive(),
  p50: z.number().finite(),
  p90: z.number().finite(),
  p95: z.number().finite(),
});
const nullablePercentileSchema = percentileSchema.nullable();

const outcomeCountsSchema = z.object({
  failed: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
});
const runtimeOutcomeCountsSchema = z.object({
  inline: outcomeCountsSchema,
  temporal: outcomeCountsSchema,
  workflow: outcomeCountsSchema,
});
const correctnessSchema = z.object({
  measured: runtimeOutcomeCountsSchema,
  warmup: runtimeOutcomeCountsSchema,
});

const telemetryCountsSchema = z.object({
  complete: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  incomplete: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
});
const runtimeTelemetryCountsSchema = z.object({
  inline: telemetryCountsSchema,
  temporal: telemetryCountsSchema,
  workflow: telemetryCountsSchema,
});
const telemetryStatusCountsSchema = z.object({
  measured: runtimeTelemetryCountsSchema,
  warmup: runtimeTelemetryCountsSchema,
});

const protocolMetricsSchema = z.object({
  firstTextEventReceivedToStopStepCompletedMs: nullablePercentileSchema,
  firstVisibleTextMs: nullablePercentileSchema,
  postAckMs: nullablePercentileSchema,
  postAckToSessionStartedEventReceivedMs: nullablePercentileSchema,
  sessionStartedToToolRequestEventReceivedMs: nullablePercentileSchema,
  sessionWaitingReducedMs: nullablePercentileSchema,
  stopStepCompletedToSessionWaitingEventReceivedMs: nullablePercentileSchema,
  toolRequestToToolStepCompletedEventReceivedMs: nullablePercentileSchema,
  toolStepCompletedToFirstTextEventReceivedMs: nullablePercentileSchema,
});
const runtimeProtocolMetricsSchema = z.object({
  inline: protocolMetricsSchema,
  temporal: protocolMetricsSchema,
  workflow: protocolMetricsSchema,
});
const pairedProtocolMetricsSchema = z.object({
  "temporal-minus-inline": protocolMetricsSchema,
  "workflow-minus-inline": protocolMetricsSchema,
});

const intervalSummarySchema = z.record(identifierSchema, percentileSchema);
const runtimeIntervalSummarySchema = z.object({
  inline: intervalSummarySchema,
  temporal: intervalSummarySchema,
  workflow: intervalSummarySchema,
});
const pairedIntervalSummarySchema = z.object({
  "temporal-minus-inline": intervalSummarySchema,
  "workflow-minus-inline": intervalSummarySchema,
});

const completedMeasurementsSchema = z.object({
  firstTextEventReceivedToStopStepCompletedMs: durationSchema,
  firstVisibleTextMs: durationSchema,
  postAckMs: durationSchema,
  postAckToSessionStartedEventReceivedMs: durationSchema,
  sessionStartedToToolRequestEventReceivedMs: durationSchema,
  sessionWaitingReducedMs: durationSchema,
  stopStepCompletedToSessionWaitingEventReceivedMs: durationSchema,
  toolRequestToToolStepCompletedEventReceivedMs: durationSchema,
  toolStepCompletedToFirstTextEventReceivedMs: durationSchema,
});
const validSampleResultSchema = z.object({
  measurements: completedMeasurementsSchema,
  outcome: z.literal("valid"),
  runtimeKind: runtimeSchema,
  targetKind: targetKindSchema,
});
const excludedSampleResultSchema = z.object({
  outcome: z.enum(["failed", "invalid"]),
  runtimeKind: runtimeSchema,
  targetKind: targetKindSchema,
});
const sampleRecordSchema = z.object({
  kind: z.literal("sample"),
  modelKind: modelKindSchema,
  phase: z.enum(["warmup", "measured"]),
  result: z.union([validSampleResultSchema, excludedSampleResultSchema]),
  runId: identifierSchema,
});

const localSetupRecordSchema = z.object({
  kind: z.literal("setup"),
  modelKind: modelKindSchema,
  runId: identifierSchema,
  targetKind: z.literal("local"),
  topology: z.literal("local-runtime-batches"),
});
const sandboxSetupRecordSchema = z.object({
  kind: z.literal("setup"),
  modelKind: modelKindSchema,
  runId: identifierSchema,
  targetKind: z.literal("vercel"),
  topology: z.literal("vercel-sandbox-runtime-batches"),
});
const summaryRecordSchema = z.object({
  correctness: correctnessSchema,
  kind: z.literal("summary"),
  measuredClientMetrics: runtimeProtocolMetricsSchema,
  modelKind: modelKindSchema,
  pairedMeasuredClientDifferences: pairedProtocolMetricsSchema,
  runId: identifierSchema,
  serverTelemetry: z.object({
    measuredSummedIntervalDurationsMsByName: runtimeIntervalSummarySchema,
    pairedMeasuredSummedIntervalDurationDifferencesMsByName: pairedIntervalSummarySchema,
    statusCounts: telemetryStatusCountsSchema,
  }),
  targetKind: targetKindSchema,
});

const benchmarkRecordSchema = z.union([
  localSetupRecordSchema,
  sandboxSetupRecordSchema,
  sampleRecordSchema,
  summaryRecordSchema,
]);
const parsedInputsSchema = z
  .array(
    z.object({
      records: z
        .array(
          z.object({
            lineNumber: z.number().int().positive(),
            record: benchmarkRecordSchema,
          }),
        )
        .min(1, "Benchmark source must contain at least one JSONL record."),
      sourceLabel: identifierSchema,
    }),
  )
  .min(1, "At least one benchmark source is required.");

type ParsedRecord = z.infer<typeof benchmarkRecordSchema>;

interface UnparsedInput {
  readonly records: readonly {
    readonly lineNumber: number;
    readonly record: unknown;
  }[];
  readonly sourceLabel: string;
}

interface LocatedRecord {
  readonly lineNumber: number;
  readonly record: ParsedRecord;
  readonly sourceLabel: string;
}

type SummaryRecord = Extract<ParsedRecord, { readonly kind: "summary" }>;

interface LocatedSummaryRecord extends Omit<LocatedRecord, "record"> {
  readonly record: SummaryRecord;
}

type SetupRecord = Extract<ParsedRecord, { readonly kind: "setup" }>;

interface LocatedSetupRecord extends Omit<LocatedRecord, "record"> {
  readonly record: SetupRecord;
}

/** Parses named benchmark JSONL documents through one validation boundary. */
export function parseBenchmarkReportInputs(
  inputs: readonly BenchmarkReportInput[],
): BenchmarkReportModel {
  const unparsedInputs = inputs.map(parseJsonlInput);
  const validation = parsedInputsSchema.safeParse(unparsedInputs);
  if (!validation.success) throw validationError(validation.error, unparsedInputs);

  const recordsByRunId = new Map<string, LocatedRecord[]>();
  for (const input of validation.data) {
    for (const line of input.records) {
      const located = {
        lineNumber: line.lineNumber,
        record: line.record,
        sourceLabel: input.sourceLabel,
      };
      const records = recordsByRunId.get(line.record.runId);
      if (records === undefined) {
        recordsByRunId.set(line.record.runId, [located]);
      } else {
        records.push(located);
      }
    }
  }

  return { runs: [...recordsByRunId].map(([runId, records]) => buildRun(runId, records)) };
}

function parseJsonlInput(input: BenchmarkReportInput): UnparsedInput {
  const records: { lineNumber: number; record: unknown }[] = [];
  for (const [index, line] of input.text.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    const lineNumber = index + 1;
    try {
      records.push({ lineNumber, record: JSON.parse(line) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SyntaxError(
        `Invalid JSON in benchmark source ${JSON.stringify(input.label)} at line ${String(lineNumber)}: ${detail}`,
      );
    }
  }
  return { records, sourceLabel: input.label };
}

function validationError(error: z.ZodError, inputs: readonly UnparsedInput[]): TypeError {
  const issue = error.issues[0];
  if (issue === undefined) return new TypeError("Benchmark input validation failed.");

  const inputIndex = issue.path[0];
  const recordIndex = issue.path[1] === "records" ? issue.path[2] : undefined;
  const input = typeof inputIndex === "number" ? inputs[inputIndex] : undefined;
  const record =
    input !== undefined && typeof recordIndex === "number" ? input.records[recordIndex] : undefined;
  if (input !== undefined && record !== undefined) {
    const fieldPath = issue.path.slice(4).join(".");
    const field = fieldPath === "" ? "" : ` at ${fieldPath}`;
    return new TypeError(
      `Invalid benchmark record in ${JSON.stringify(input.sourceLabel)} at line ${String(record.lineNumber)}${field}: ${issue.message}`,
    );
  }
  if (input !== undefined) {
    return new TypeError(
      `Invalid benchmark source ${JSON.stringify(input.sourceLabel)}: ${issue.message}`,
    );
  }
  return new TypeError(`Invalid benchmark inputs: ${issue.message}`);
}

function buildRun(runId: string, records: readonly LocatedRecord[]): BenchmarkReportRun {
  const summaries = records.filter(isLocatedSummaryRecord);
  const [summary] = summaries;
  if (summary === undefined || summaries.length !== 1) {
    throw runError(
      runId,
      records,
      `expected exactly one summary record; found ${String(summaries.length)}`,
    );
  }

  const setups = records.filter(isLocatedSetupRecord);
  if (setups.length > 1) {
    throw runError(
      runId,
      setups,
      `expected at most one setup record; found ${String(setups.length)}`,
    );
  }

  validateRunIdentity(runId, records, summary);
  const samples = records.filter(
    (record) =>
      record.record.kind === "sample" &&
      record.record.phase === "measured" &&
      record.record.result.outcome === "valid",
  );
  const setup = setups[0];
  const summaryRecord = summary.record;

  return {
    comparisons: {
      "temporal-minus-inline": pairedMetrics(summaryRecord, "temporal-minus-inline"),
      "workflow-minus-inline": pairedMetrics(summaryRecord, "workflow-minus-inline"),
    },
    correctness: summaryRecord.correctness,
    modelKind: summaryRecord.modelKind,
    runId,
    runtimes: {
      inline: runtimeMetrics(summaryRecord, samples, "inline"),
      temporal: runtimeMetrics(summaryRecord, samples, "temporal"),
      workflow: runtimeMetrics(summaryRecord, samples, "workflow"),
    },
    sourceLabels: [...new Set(records.map((record) => record.sourceLabel))],
    targetKind: summaryRecord.targetKind,
    telemetryStatusCounts: summaryRecord.serverTelemetry.statusCounts,
    topology: setup?.record.topology ?? null,
  };
}

function validateRunIdentity(
  runId: string,
  records: readonly LocatedRecord[],
  summary: LocatedSummaryRecord,
): void {
  for (const located of records) {
    const record = located.record;
    const targetKind = record.kind === "sample" ? record.result.targetKind : record.targetKind;
    if (record.modelKind !== summary.record.modelKind) {
      throw locatedError(
        located,
        `run ${JSON.stringify(runId)} mixes model kinds ${JSON.stringify(summary.record.modelKind)} and ${JSON.stringify(record.modelKind)}`,
      );
    }
    if (targetKind !== summary.record.targetKind) {
      throw locatedError(
        located,
        `run ${JSON.stringify(runId)} mixes target kinds ${JSON.stringify(summary.record.targetKind)} and ${JSON.stringify(targetKind)}`,
      );
    }
  }
}

function runtimeMetrics(
  summary: SummaryRecord,
  samples: readonly LocatedRecord[],
  runtime: BenchmarkReportRuntime,
): BenchmarkReportRuntimeMetrics {
  const runtimeSamples = samples.flatMap((located) => {
    const record = located.record;
    return record.kind === "sample" &&
      record.result.outcome === "valid" &&
      record.result.runtimeKind === runtime
      ? [record.result.measurements]
      : [];
  });
  const client = summary.measuredClientMetrics[runtime];

  return {
    e2eSessionWaitingReducedMs: client.sessionWaitingReducedMs,
    firstVisibleTextMs: client.firstVisibleTextMs,
    measuredValidSampleCount: runtimeSamples.length,
    protocolPhaseMeansMs: {
      firstTextEventReceivedToStopStepCompletedMs: mean(
        runtimeSamples.map((sample) => sample.firstTextEventReceivedToStopStepCompletedMs),
      ),
      postAckMs: mean(runtimeSamples.map((sample) => sample.postAckMs)),
      postAckToSessionStartedEventReceivedMs: mean(
        runtimeSamples.map((sample) => sample.postAckToSessionStartedEventReceivedMs),
      ),
      sessionStartedToToolRequestEventReceivedMs: mean(
        runtimeSamples.map((sample) => sample.sessionStartedToToolRequestEventReceivedMs),
      ),
      stopStepCompletedToSessionWaitingEventReceivedMs: mean(
        runtimeSamples.map((sample) => sample.stopStepCompletedToSessionWaitingEventReceivedMs),
      ),
      toolRequestToToolStepCompletedEventReceivedMs: mean(
        runtimeSamples.map((sample) => sample.toolRequestToToolStepCompletedEventReceivedMs),
      ),
      toolStepCompletedToFirstTextEventReceivedMs: mean(
        runtimeSamples.map((sample) => sample.toolStepCompletedToFirstTextEventReceivedMs),
      ),
    },
    protocolPhasePercentilesMs: {
      firstTextEventReceivedToStopStepCompletedMs:
        client.firstTextEventReceivedToStopStepCompletedMs,
      postAckMs: client.postAckMs,
      postAckToSessionStartedEventReceivedMs: client.postAckToSessionStartedEventReceivedMs,
      sessionStartedToToolRequestEventReceivedMs: client.sessionStartedToToolRequestEventReceivedMs,
      stopStepCompletedToSessionWaitingEventReceivedMs:
        client.stopStepCompletedToSessionWaitingEventReceivedMs,
      toolRequestToToolStepCompletedEventReceivedMs:
        client.toolRequestToToolStepCompletedEventReceivedMs,
      toolStepCompletedToFirstTextEventReceivedMs:
        client.toolStepCompletedToFirstTextEventReceivedMs,
    },
    serverIntervalPercentilesMsByName: sortRecord(
      summary.serverTelemetry.measuredSummedIntervalDurationsMsByName[runtime],
    ),
  };
}

function pairedMetrics(
  summary: SummaryRecord,
  comparison: BenchmarkReportComparison,
): BenchmarkReportPairedMetrics {
  return {
    e2eSessionWaitingReducedMs:
      summary.pairedMeasuredClientDifferences[comparison].sessionWaitingReducedMs,
    serverIntervalPercentilesMsByName: sortRecord(
      summary.serverTelemetry.pairedMeasuredSummedIntervalDurationDifferencesMsByName[comparison],
    ),
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let result = 0;
  for (const [index, value] of values.entries()) result += (value - result) / (index + 1);
  return result;
}

function sortRecord<T>(values: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.fromEntries(
    Object.entries(values).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function runError(runId: string, records: readonly LocatedRecord[], detail: string): TypeError {
  const locations = records
    .map((record) => `${JSON.stringify(record.sourceLabel)} line ${String(record.lineNumber)}`)
    .join(", ");
  return new TypeError(
    `Invalid benchmark run ${JSON.stringify(runId)} at ${locations}: ${detail}.`,
  );
}

function locatedError(record: LocatedRecord, detail: string): TypeError {
  return new TypeError(
    `Invalid benchmark record in ${JSON.stringify(record.sourceLabel)} at line ${String(record.lineNumber)}: ${detail}.`,
  );
}

function isLocatedSummaryRecord(record: LocatedRecord): record is LocatedSummaryRecord {
  return record.record.kind === "summary";
}

function isLocatedSetupRecord(record: LocatedRecord): record is LocatedSetupRecord {
  return record.record.kind === "setup";
}
