import { describe, expect, it } from "vitest";

import type {
  BenchmarkReportModel,
  BenchmarkReportPercentiles,
  BenchmarkReportProtocolPhase,
  BenchmarkReportRuntimeMetrics,
} from "./model.js";
import { renderBenchmarkReportHtml } from "./render-html.js";

describe("renderBenchmarkReportHtml", () => {
  it("renders latency, additive layers, paired overhead, and escaped metadata", () => {
    const html = renderBenchmarkReportHtml(reportFixture());

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("End-to-end agent latency");
    expect(html).toContain("Client-observed request timeline");
    expect(html).toContain("Paired implementation delta");
    expect(html).toContain("Neutral server intervals");
    expect(html).toContain("local&lt;results&gt;.jsonl");
    expect(html).toContain("+190.0 ms");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("defines protocol boundaries and identifies their code origins", () => {
    const html = renderBenchmarkReportHtml(reportFixture());

    expect(html).toContain("Client-observed request timeline");
    expect(html).toContain(
      "<code>actions.requested(tool-call)</code> received → <code>step.completed(tool-calls)</code> received",
    );
    expect(html).toContain(
      "First visible response text → final model step <code>step.completed(stop)</code>",
    );
    expect(html).toContain(
      "Final model step → ready for the next message <code>session.waiting</code>",
    );
    expect(html).toContain("Marker sources in code");
    expect(html).toContain("runBenchmarkSample()");
    expect(html).toContain("emitTurnPreamble()");
    expect(html).toContain("emitStepActions()");
    expect(html).toContain("emitStreamContent()");
    expect(html).toContain("emitTurnEpilogue()");
    expect(html).toContain(
      "The streamed benchmark path emits <code>actions.requested</code> and <code>action.result</code>",
    );
    expect(html).toContain("<code>emitStepActions()</code> then emits <code>step.completed</code>");
    expect(html).toContain(
      "<code>turn.completed</code> is emitted between <code>step.completed(stop)</code> and <code>session.waiting</code>.",
    );
  });

  it("renders a hosted single-runtime run as client-only and marks absent runtimes not run", () => {
    const html = renderBenchmarkReportHtml(hostedReportFixture());

    expect(html).toContain("client complete");
    expect(html).toContain("30/30 valid · client timing only");
    expect(html.match(/>not run</g)).toHaveLength(2);
    expect(html.match(/No measured samples/g)).toHaveLength(2);
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("rejects a report without runs", () => {
    expect(() => renderBenchmarkReportHtml({ runs: [] })).toThrow(
      "Cannot render an empty benchmark report",
    );
  });
});

function reportFixture(): BenchmarkReportModel {
  const counts = { failed: 0, invalid: 0, valid: 30 };
  const telemetry = { complete: 30, failed: 0, incomplete: 0, unavailable: 0 };
  return {
    runs: [
      {
        comparisons: {
          "temporal-minus-inline": pairedMetrics(378),
          "workflow-minus-inline": pairedMetrics(190),
        },
        correctness: {
          measured: { inline: counts, temporal: counts, workflow: counts },
          warmup: { inline: counts, temporal: counts, workflow: counts },
        },
        modelKind: "deterministic",
        runId: "run-1",
        runtimes: {
          inline: runtimeMetrics(2.4, 2.1, 0.2),
          temporal: runtimeMetrics(381, 380, 30),
          workflow: runtimeMetrics(193, 149, 12),
        },
        sourceLabels: ["local<results>.jsonl"],
        targetKind: "local",
        telemetryStatusCounts: {
          measured: { inline: telemetry, temporal: telemetry, workflow: telemetry },
          warmup: { inline: telemetry, temporal: telemetry, workflow: telemetry },
        },
        topology: "local-runtime-batches",
      },
    ],
  };
}

function hostedReportFixture(): BenchmarkReportModel {
  const base = reportFixture().runs[0];
  if (base === undefined) throw new Error("Expected a report fixture run.");
  const emptyCounts = { failed: 0, invalid: 0, valid: 0 };
  const selectedCounts = { failed: 0, invalid: 0, valid: 30 };
  const emptyTelemetry = { complete: 0, failed: 0, incomplete: 0, unavailable: 0 };
  const selectedTelemetry = { complete: 0, failed: 0, incomplete: 0, unavailable: 30 };

  return {
    runs: [
      {
        ...base,
        comparisons: {
          "temporal-minus-inline": emptyPairedMetrics(),
          "workflow-minus-inline": emptyPairedMetrics(),
        },
        correctness: {
          measured: {
            inline: emptyCounts,
            temporal: emptyCounts,
            workflow: selectedCounts,
          },
          warmup: {
            inline: emptyCounts,
            temporal: emptyCounts,
            workflow: selectedCounts,
          },
        },
        runtimes: {
          inline: emptyRuntimeMetrics(),
          temporal: emptyRuntimeMetrics(),
          workflow: {
            ...runtimeMetrics(193, 149, 12),
            serverIntervalPercentilesMsByName: {},
          },
        },
        targetKind: "vercel",
        telemetryStatusCounts: {
          measured: {
            inline: emptyTelemetry,
            temporal: emptyTelemetry,
            workflow: selectedTelemetry,
          },
          warmup: {
            inline: emptyTelemetry,
            temporal: emptyTelemetry,
            workflow: selectedTelemetry,
          },
        },
        topology: null,
      },
    ],
  };
}

function emptyRuntimeMetrics(): BenchmarkReportRuntimeMetrics {
  return {
    e2eSessionWaitingReducedMs: null,
    firstVisibleTextMs: null,
    measuredValidSampleCount: 0,
    protocolPhaseMeansMs: phases(null),
    protocolPhasePercentilesMs: phasePercentiles(null),
    serverIntervalPercentilesMsByName: {},
  };
}

function emptyPairedMetrics() {
  return {
    e2eSessionWaitingReducedMs: null,
    serverIntervalPercentilesMsByName: {},
  };
}

function runtimeMetrics(
  e2eP50: number,
  firstTextP50: number,
  phaseValue: number,
): BenchmarkReportRuntimeMetrics {
  return {
    e2eSessionWaitingReducedMs: percentiles(e2eP50),
    firstVisibleTextMs: percentiles(firstTextP50),
    measuredValidSampleCount: 30,
    protocolPhaseMeansMs: phases(phaseValue),
    protocolPhasePercentilesMs: phasePercentiles(phaseValue),
    serverIntervalPercentilesMsByName: {
      "engine.dispatch": percentiles(phaseValue),
      "turn.step.operation": percentiles(phaseValue * 2),
    },
  };
}

function pairedMetrics(value: number) {
  return {
    e2eSessionWaitingReducedMs: percentiles(value),
    serverIntervalPercentilesMsByName: {
      "engine.dispatch": percentiles(value / 10),
      "turn.step.operation": percentiles(value / 5),
    },
  };
}

function percentiles(p50: number): BenchmarkReportPercentiles {
  return { count: 30, p50, p90: p50 * 1.1, p95: p50 * 1.2 };
}

function phases(
  value: number | null,
): Readonly<Record<BenchmarkReportProtocolPhase, number | null>> {
  return {
    firstTextEventReceivedToStopStepCompletedMs: value,
    postAckMs: value,
    postAckToSessionStartedEventReceivedMs: value,
    sessionStartedToToolRequestEventReceivedMs: value,
    stopStepCompletedToSessionWaitingEventReceivedMs: value,
    toolRequestToToolStepCompletedEventReceivedMs: value,
    toolStepCompletedToFirstTextEventReceivedMs: value,
  };
}

function phasePercentiles(
  value: number | null,
): Readonly<Record<BenchmarkReportProtocolPhase, BenchmarkReportPercentiles | null>> {
  const summary = value === null ? null : percentiles(value);
  return {
    firstTextEventReceivedToStopStepCompletedMs: summary,
    postAckMs: summary,
    postAckToSessionStartedEventReceivedMs: summary,
    sessionStartedToToolRequestEventReceivedMs: summary,
    stopStepCompletedToSessionWaitingEventReceivedMs: summary,
    toolRequestToToolStepCompletedEventReceivedMs: summary,
    toolStepCompletedToFirstTextEventReceivedMs: summary,
  };
}
