import { describe, expect, it } from "vitest";

import { BENCHMARK_REPORT_PROTOCOL_PHASES, parseBenchmarkReportInputs } from "./model.js";

describe("parseBenchmarkReportInputs", () => {
  it("groups sources by run and builds measured-valid phase means", () => {
    const localSummary = summaryRecord({
      modelKind: "deterministic",
      runId: "local-run",
      scale: 10,
      targetKind: "local",
    });
    const report = parseBenchmarkReportInputs([
      {
        label: "local-first.jsonl",
        text: jsonl(
          setupRecord("local-run", "deterministic", "local"),
          sampleRecord("local-run", "deterministic", "local", "inline", "measured", "valid", 1),
          sampleRecord("local-run", "deterministic", "local", "inline", "measured", "valid", 3),
          sampleRecord("local-run", "deterministic", "local", "inline", "warmup", "valid", 100),
          sampleRecord("local-run", "deterministic", "local", "inline", "measured", "invalid", 200),
        ),
      },
      {
        label: "local-second.jsonl",
        text: jsonl(
          sampleRecord("local-run", "deterministic", "local", "workflow", "measured", "valid", 4),
          sampleRecord("local-run", "deterministic", "local", "temporal", "measured", "valid", 6),
          localSummary,
        ),
      },
      {
        label: "vercel.jsonl",
        text: jsonl(
          setupRecord("vercel-run", "live", "vercel"),
          summaryRecord({
            modelKind: "live",
            runId: "vercel-run",
            scale: 20,
            targetKind: "vercel",
          }),
        ),
      },
    ]);

    expect(report.runs).toHaveLength(2);
    const local = report.runs[0];
    if (local === undefined) throw new Error("Expected a local report run.");

    expect(local).toMatchObject({
      modelKind: "deterministic",
      runId: "local-run",
      sourceLabels: ["local-first.jsonl", "local-second.jsonl"],
      targetKind: "local",
      topology: "local-runtime-batches",
    });
    expect(local.runtimes.inline.measuredValidSampleCount).toBe(2);
    expect(local.runtimes.workflow.measuredValidSampleCount).toBe(1);
    expect(local.runtimes.temporal.measuredValidSampleCount).toBe(1);
    expect(local.runtimes.inline.protocolPhaseMeansMs).toEqual(
      Object.fromEntries(BENCHMARK_REPORT_PROTOCOL_PHASES.map((phase) => [phase, 2])),
    );
    expect(local.runtimes.workflow.protocolPhaseMeansMs.postAckMs).toBe(4);
    expect(local.runtimes.temporal.protocolPhaseMeansMs.postAckMs).toBe(6);

    expect(local.runtimes.inline.e2eSessionWaitingReducedMs).toEqual(percentiles(10));
    expect(local.runtimes.workflow.firstVisibleTextMs).toEqual(percentiles(20));
    expect(local.runtimes.temporal.protocolPhasePercentilesMs.postAckMs).toEqual(percentiles(30));
    expect(local.comparisons["workflow-minus-inline"].e2eSessionWaitingReducedMs).toEqual(
      percentiles(10),
    );
    expect(local.comparisons["temporal-minus-inline"].e2eSessionWaitingReducedMs).toEqual(
      percentiles(20),
    );
    expect(local.runtimes.inline.serverIntervalPercentilesMsByName).toEqual({
      "engine.dispatch": percentiles(10),
      "turn.step.operation": percentiles(11),
    });
    expect(local.comparisons["workflow-minus-inline"].serverIntervalPercentilesMsByName).toEqual({
      "engine.dispatch": percentiles(10),
    });
    expect(local.correctness).toEqual(localSummary.correctness);
    expect(local.telemetryStatusCounts).toEqual(localSummary.serverTelemetry.statusCounts);

    expect(report.runs[1]).toMatchObject({
      modelKind: "live",
      runId: "vercel-run",
      sourceLabels: ["vercel.jsonl"],
      targetKind: "vercel",
      topology: "vercel-sandbox-runtime-batches",
    });
  });

  it("parses a hosted single-runtime summary without inventing data for absent runtimes", () => {
    const emptyCounts = { failed: 0, invalid: 0, valid: 0 };
    const selectedCounts = { failed: 0, invalid: 0, valid: 1 };
    const emptyTelemetry = { complete: 0, failed: 0, incomplete: 0, unavailable: 0 };
    const selectedTelemetry = { complete: 0, failed: 0, incomplete: 0, unavailable: 1 };
    const summary = {
      ...summaryRecord({
        modelKind: "live",
        runId: "hosted-run",
        scale: 1,
        targetKind: "vercel",
      }),
      correctness: {
        measured: {
          inline: emptyCounts,
          temporal: emptyCounts,
          workflow: selectedCounts,
        },
        warmup: {
          inline: emptyCounts,
          temporal: emptyCounts,
          workflow: emptyCounts,
        },
      },
      measuredClientMetrics: {
        inline: emptyMetricSummary(),
        temporal: emptyMetricSummary(),
        workflow: metricSummary(2),
      },
      pairedMeasuredClientDifferences: {
        "temporal-minus-inline": emptyMetricSummary(),
        "workflow-minus-inline": emptyMetricSummary(),
      },
      serverTelemetry: {
        measuredSummedIntervalDurationsMsByName: {
          inline: {},
          temporal: {},
          workflow: {},
        },
        pairedMeasuredSummedIntervalDurationDifferencesMsByName: {
          "temporal-minus-inline": {},
          "workflow-minus-inline": {},
        },
        statusCounts: {
          measured: {
            inline: emptyTelemetry,
            temporal: emptyTelemetry,
            workflow: selectedTelemetry,
          },
          warmup: {
            inline: emptyTelemetry,
            temporal: emptyTelemetry,
            workflow: emptyTelemetry,
          },
        },
      },
    };
    const report = parseBenchmarkReportInputs([
      {
        label: "hosted.jsonl",
        text: jsonl(
          sampleRecord("hosted-run", "live", "vercel", "workflow", "measured", "valid", 2),
          summary,
        ),
      },
    ]);
    const run = report.runs[0];
    if (run === undefined) throw new Error("Expected a hosted report run.");

    expect(run.topology).toBeNull();
    expect(run.runtimes.inline.measuredValidSampleCount).toBe(0);
    expect(run.runtimes.inline.e2eSessionWaitingReducedMs).toBeNull();
    expect(run.runtimes.inline.protocolPhaseMeansMs).toEqual(
      Object.fromEntries(BENCHMARK_REPORT_PROTOCOL_PHASES.map((phase) => [phase, null])),
    );
    expect(run.runtimes.workflow.measuredValidSampleCount).toBe(1);
    expect(run.runtimes.workflow.e2eSessionWaitingReducedMs).toEqual(percentiles(2));
    expect(run.comparisons["workflow-minus-inline"].e2eSessionWaitingReducedMs).toBeNull();
    expect(run.telemetryStatusCounts.measured.workflow).toEqual(selectedTelemetry);
  });

  it("reports invalid JSON with its source and line", () => {
    expect(() =>
      parseBenchmarkReportInputs([
        {
          label: "broken.jsonl",
          text: `${JSON.stringify(setupRecord("run", "deterministic", "local"))}\n{nope}\n`,
        },
      ]),
    ).toThrow('Invalid JSON in benchmark source "broken.jsonl" at line 2');
  });

  it("reports invalid records with their source and line", () => {
    expect(() =>
      parseBenchmarkReportInputs([
        {
          label: "invalid-record.jsonl",
          text: jsonl(setupRecord("run", "deterministic", "local"), {
            kind: "summary",
            runId: "run",
          }),
        },
      ]),
    ).toThrow('Invalid benchmark record in "invalid-record.jsonl" at line 2');
  });

  it("requires exactly one summary for every run", () => {
    expect(() =>
      parseBenchmarkReportInputs([
        {
          label: "missing-summary.jsonl",
          text: jsonl(setupRecord("run", "deterministic", "local")),
        },
      ]),
    ).toThrow(
      'Invalid benchmark run "run" at "missing-summary.jsonl" line 1: expected exactly one summary record; found 0.',
    );

    const summary = summaryRecord({
      modelKind: "deterministic",
      runId: "run",
      scale: 1,
      targetKind: "local",
    });
    expect(() =>
      parseBenchmarkReportInputs([
        { label: "duplicate-summary.jsonl", text: jsonl(summary, summary) },
      ]),
    ).toThrow("expected exactly one summary record; found 2");
  });

  it("rejects target or model mixing within one run id", () => {
    expect(() =>
      parseBenchmarkReportInputs([
        {
          label: "mixed.jsonl",
          text: jsonl(
            setupRecord("run", "deterministic", "local"),
            sampleRecord("run", "deterministic", "vercel", "inline", "measured", "valid", 1),
            summaryRecord({
              modelKind: "deterministic",
              runId: "run",
              scale: 1,
              targetKind: "local",
            }),
          ),
        },
      ]),
    ).toThrow(
      'Invalid benchmark record in "mixed.jsonl" at line 2: run "run" mixes target kinds "local" and "vercel".',
    );
  });
});

type ModelKind = "deterministic" | "live";
type Runtime = "inline" | "workflow" | "temporal";
type TargetKind = "local" | "vercel";

function setupRecord(runId: string, modelKind: ModelKind, targetKind: TargetKind) {
  return targetKind === "local"
    ? {
        kind: "setup",
        modelKind,
        runId,
        targetKind,
        topology: "local-runtime-batches",
      }
    : {
        kind: "setup",
        modelKind,
        runId,
        targetKind,
        topology: "vercel-sandbox-runtime-batches",
      };
}

function sampleRecord(
  runId: string,
  modelKind: ModelKind,
  targetKind: TargetKind,
  runtimeKind: Runtime,
  phase: "measured" | "warmup",
  outcome: "invalid" | "valid",
  value: number,
) {
  const identity = { outcome, runtimeKind, targetKind };
  return {
    kind: "sample",
    modelKind,
    phase,
    result:
      outcome === "valid" ? { ...identity, measurements: completedMeasurements(value) } : identity,
    runId,
  };
}

function completedMeasurements(value: number) {
  return {
    firstTextEventReceivedToStopStepCompletedMs: value,
    firstVisibleTextMs: value,
    postAckMs: value,
    postAckToSessionStartedEventReceivedMs: value,
    sessionStartedToToolRequestEventReceivedMs: value,
    sessionWaitingReducedMs: value,
    stopStepCompletedToSessionWaitingEventReceivedMs: value,
    toolRequestToToolStepCompletedEventReceivedMs: value,
    toolStepCompletedToFirstTextEventReceivedMs: value,
  };
}

function summaryRecord(input: {
  readonly modelKind: ModelKind;
  readonly runId: string;
  readonly scale: number;
  readonly targetKind: TargetKind;
}) {
  const inlineMetrics = metricSummary(input.scale);
  const workflowMetrics = metricSummary(input.scale * 2);
  const temporalMetrics = metricSummary(input.scale * 3);
  const emptyCounts = { failed: 0, invalid: 0, valid: 0 };
  const completeCounts = { complete: 1, failed: 0, incomplete: 0, unavailable: 0 };
  const emptyTelemetryCounts = { complete: 0, failed: 0, incomplete: 0, unavailable: 0 };

  return {
    correctness: {
      measured: {
        inline: { failed: 0, invalid: 0, valid: 2 },
        temporal: { failed: 0, invalid: 0, valid: 1 },
        workflow: { failed: 0, invalid: 0, valid: 1 },
      },
      warmup: {
        inline: emptyCounts,
        temporal: emptyCounts,
        workflow: emptyCounts,
      },
    },
    kind: "summary",
    measuredClientMetrics: {
      inline: inlineMetrics,
      temporal: temporalMetrics,
      workflow: workflowMetrics,
    },
    modelKind: input.modelKind,
    pairedMeasuredClientDifferences: {
      "temporal-minus-inline": metricSummary(input.scale * 2),
      "workflow-minus-inline": metricSummary(input.scale),
    },
    runId: input.runId,
    serverTelemetry: {
      measuredSummedIntervalDurationsMsByName: {
        inline: {
          "engine.dispatch": percentiles(input.scale),
          "turn.step.operation": percentiles(input.scale + 1),
        },
        temporal: { "engine.dispatch": percentiles(input.scale * 3) },
        workflow: { "engine.dispatch": percentiles(input.scale * 2) },
      },
      pairedMeasuredSummedIntervalDurationDifferencesMsByName: {
        "temporal-minus-inline": { "engine.dispatch": percentiles(input.scale * 2) },
        "workflow-minus-inline": { "engine.dispatch": percentiles(input.scale) },
      },
      statusCounts: {
        measured: {
          inline: completeCounts,
          temporal: completeCounts,
          workflow: completeCounts,
        },
        warmup: {
          inline: emptyTelemetryCounts,
          temporal: emptyTelemetryCounts,
          workflow: emptyTelemetryCounts,
        },
      },
    },
    targetKind: input.targetKind,
  };
}

function metricSummary(value: number) {
  return {
    firstTextEventReceivedToStopStepCompletedMs: percentiles(value),
    firstVisibleTextMs: percentiles(value),
    postAckMs: percentiles(value),
    postAckToSessionStartedEventReceivedMs: percentiles(value),
    sessionStartedToToolRequestEventReceivedMs: percentiles(value),
    sessionWaitingReducedMs: percentiles(value),
    stopStepCompletedToSessionWaitingEventReceivedMs: percentiles(value),
    toolRequestToToolStepCompletedEventReceivedMs: percentiles(value),
    toolStepCompletedToFirstTextEventReceivedMs: percentiles(value),
  };
}

function emptyMetricSummary() {
  return {
    firstTextEventReceivedToStopStepCompletedMs: null,
    firstVisibleTextMs: null,
    postAckMs: null,
    postAckToSessionStartedEventReceivedMs: null,
    sessionStartedToToolRequestEventReceivedMs: null,
    sessionWaitingReducedMs: null,
    stopStepCompletedToSessionWaitingEventReceivedMs: null,
    toolRequestToToolStepCompletedEventReceivedMs: null,
    toolStepCompletedToFirstTextEventReceivedMs: null,
  };
}

function percentiles(value: number) {
  return { count: 1, p50: value, p90: value, p95: value };
}

function jsonl(...records: readonly unknown[]): string {
  return `${records.map(encodeJson).join("\n")}\n`;
}

function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Test record is not JSON serializable.");
  return encoded;
}
