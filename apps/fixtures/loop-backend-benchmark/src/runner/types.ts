import type {
  BenchmarkRuntimeKind,
  BenchmarkSampleResult,
  BenchmarkTargetKind,
} from "../driver/index.js";
import type { BenchmarkModelKind } from "../model-kind.js";
import type { ServerTelemetryResult } from "./server-telemetry.js";

export const BENCHMARK_RUNTIMES: readonly BenchmarkRuntimeKind[] = [
  "inline",
  "workflow",
  "temporal",
];

export interface BenchmarkRuntimeUrls {
  readonly inline: string;
  readonly temporal: string;
  readonly workflow: string;
}

export interface BenchmarkMatrixConfig {
  readonly measuredBlocks: number;
  readonly modelKind: BenchmarkModelKind;
  readonly runId: string;
  readonly runtimeUrls: BenchmarkRuntimeUrls;
  readonly seed: number;
  readonly targetKind: BenchmarkTargetKind;
  readonly warmupBlocks: number;
}

export type BenchmarkPhase = "measured" | "warmup";

export interface BenchmarkScheduleEntry {
  readonly blockIndex: number;
  readonly orderInBlock: number;
  readonly phase: BenchmarkPhase;
  readonly runtimeKind: BenchmarkRuntimeKind;
}

export interface BenchmarkSampleRecord {
  readonly blockIndex: number;
  readonly kind: "sample";
  readonly modelKind: BenchmarkModelKind;
  readonly orderInBlock: number;
  readonly phase: BenchmarkPhase;
  readonly result: BenchmarkSampleResult;
  readonly runId: string;
  readonly sampleIndex: number;
  readonly serverTelemetry: ServerTelemetryResult;
}

export interface BenchmarkOutcomeCounts {
  readonly failed: number;
  readonly invalid: number;
  readonly valid: number;
}

export interface RuntimeOutcomeCounts {
  readonly inline: BenchmarkOutcomeCounts;
  readonly temporal: BenchmarkOutcomeCounts;
  readonly workflow: BenchmarkOutcomeCounts;
}

export interface ServerTelemetryStatusCounts {
  readonly complete: number;
  readonly failed: number;
  readonly incomplete: number;
  readonly unavailable: number;
}

export interface RuntimeServerTelemetryStatusCounts {
  readonly inline: ServerTelemetryStatusCounts;
  readonly temporal: ServerTelemetryStatusCounts;
  readonly workflow: ServerTelemetryStatusCounts;
}

export interface PercentileSummary {
  readonly count: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
}

export interface ClientMetricSummary {
  readonly firstDecodedEventMs: PercentileSummary | null;
  readonly firstTextEventReceivedToStopStepCompletedMs: PercentileSummary | null;
  readonly firstVisibleTextMs: PercentileSummary | null;
  readonly postAckMs: PercentileSummary | null;
  readonly postAckToSessionStartedEventReceivedMs: PercentileSummary | null;
  readonly reducerTotalMs: PercentileSummary | null;
  readonly sessionStartedToToolRequestEventReceivedMs: PercentileSummary | null;
  readonly sessionWaitingEventReceivedMs: PercentileSummary | null;
  readonly sessionWaitingReducedMs: PercentileSummary | null;
  readonly stopStepCompletedToSessionWaitingEventReceivedMs: PercentileSummary | null;
  readonly toolRequestToToolStepCompletedEventReceivedMs: PercentileSummary | null;
  readonly toolStepCompletedToFirstTextEventReceivedMs: PercentileSummary | null;
}

export interface RuntimeClientMetricSummary {
  readonly inline: ClientMetricSummary;
  readonly temporal: ClientMetricSummary;
  readonly workflow: ClientMetricSummary;
}

export interface PairedClientMetricSummary {
  readonly "temporal-minus-inline": ClientMetricSummary;
  readonly "temporal-minus-workflow": ClientMetricSummary;
  readonly "workflow-minus-inline": ClientMetricSummary;
}

export type IntervalDurationSummary = Readonly<Record<string, PercentileSummary>>;

export interface RuntimeIntervalDurationSummary {
  readonly inline: IntervalDurationSummary;
  readonly temporal: IntervalDurationSummary;
  readonly workflow: IntervalDurationSummary;
}

export interface PairedIntervalDurationSummary {
  readonly "temporal-minus-inline": IntervalDurationSummary;
  readonly "temporal-minus-workflow": IntervalDurationSummary;
  readonly "workflow-minus-inline": IntervalDurationSummary;
}

export interface BenchmarkSummaryRecord {
  readonly blocks: {
    readonly measured: number;
    readonly warmup: number;
  };
  readonly correctness: {
    readonly measured: RuntimeOutcomeCounts;
    readonly warmup: RuntimeOutcomeCounts;
  };
  readonly kind: "summary";
  readonly measuredClientMetrics: RuntimeClientMetricSummary;
  readonly modelKind: BenchmarkModelKind;
  readonly pairedMeasuredClientDifferences: PairedClientMetricSummary;
  readonly runId: string;
  readonly seed: number;
  readonly targetKind: BenchmarkTargetKind;
  readonly serverTelemetry: {
    readonly measuredSummedIntervalDurationsMsByName: RuntimeIntervalDurationSummary;
    readonly pairedMeasuredSummedIntervalDurationDifferencesMsByName: PairedIntervalDurationSummary;
    readonly statusCounts: {
      readonly measured: RuntimeServerTelemetryStatusCounts;
      readonly warmup: RuntimeServerTelemetryStatusCounts;
    };
  };
}

export type BenchmarkJsonlRecord = BenchmarkSampleRecord | BenchmarkSummaryRecord;
