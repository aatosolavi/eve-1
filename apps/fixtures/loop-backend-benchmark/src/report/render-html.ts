import {
  BENCHMARK_REPORT_COMPARISONS,
  BENCHMARK_REPORT_PROTOCOL_PHASES,
  BENCHMARK_REPORT_RUNTIMES,
  type BenchmarkReportComparison,
  type BenchmarkReportModel,
  type BenchmarkReportProtocolPhase,
  type BenchmarkReportRun,
  type BenchmarkReportRuntime,
} from "./model.js";

const RUNTIME_LABELS = {
  inline: "Inline",
  temporal: "Temporal",
  workflow: "Workflow",
} satisfies Readonly<Record<BenchmarkReportRuntime, string>>;

const COMPARISON_LABELS = {
  "temporal-minus-inline": "Temporal − inline",
  "workflow-minus-inline": "Workflow − inline",
} satisfies Readonly<Record<BenchmarkReportComparison, string>>;

interface ProtocolPhaseDetail {
  readonly accessibleLabel: string;
  readonly boundaryHtml: string;
  readonly labelHtml: string;
}

const PHASE_DETAILS = {
  firstTextEventReceivedToStopStepCompletedMs: {
    accessibleLabel: "First visible response text to final model step completed",
    boundaryHtml:
      "First received event whose reduction exposes non-empty assistant text → <code>step.completed(stop)</code> received",
    labelHtml: "First visible response text → final model step <code>step.completed(stop)</code>",
  },
  postAckMs: {
    accessibleLabel: "Request started to POST acknowledged",
    boundaryHtml:
      "<code>performance.now()</code> before <code>session.send()</code> → <code>session.send()</code> resolves",
    labelHtml: "Request started → POST acknowledged",
  },
  postAckToSessionStartedEventReceivedMs: {
    accessibleLabel: "POST acknowledged to session started received",
    boundaryHtml: "<code>session.send()</code> resolves → <code>session.started</code> received",
    labelHtml: "POST acknowledged → session started <code>session.started</code>",
  },
  sessionStartedToToolRequestEventReceivedMs: {
    accessibleLabel: "Session started to tool call requested",
    boundaryHtml:
      "<code>session.started</code> received → <code>actions.requested(tool-call)</code> received",
    labelHtml: "Session started → tool call requested <code>actions.requested</code>",
  },
  stopStepCompletedToSessionWaitingEventReceivedMs: {
    accessibleLabel: "Final model step completed to ready for the next message",
    boundaryHtml:
      "<code>step.completed(stop)</code> received → <code>session.waiting</code> received",
    labelHtml: "Final model step → ready for the next message <code>session.waiting</code>",
  },
  toolRequestToToolStepCompletedEventReceivedMs: {
    accessibleLabel: "Tool call requested to tool-call model step completed",
    boundaryHtml:
      "<code>actions.requested(tool-call)</code> received → <code>step.completed(tool-calls)</code> received",
    labelHtml:
      "Tool call requested → tool-call model step completed <code>step.completed(tool-calls)</code>",
  },
  toolStepCompletedToFirstTextEventReceivedMs: {
    accessibleLabel: "Tool-call model step completed to first visible response text",
    boundaryHtml:
      "<code>step.completed(tool-calls)</code> received → first received event whose reduction exposes non-empty assistant text",
    labelHtml: "Tool-call model step completed → first visible response text",
  },
} satisfies Readonly<Record<BenchmarkReportProtocolPhase, ProtocolPhaseDetail>>;

/** Renders a dependency-free HTML report from parsed benchmark runs. */
export function renderBenchmarkReportHtml(report: BenchmarkReportModel): string {
  if (report.runs.length === 0) throw new TypeError("Cannot render an empty benchmark report.");

  const modelKinds = new Set(report.runs.map((run) => run.modelKind));
  const mixedModelWarning =
    modelKinds.size > 1
      ? '<p class="warning">These runs use different model kinds. Compare runtime shapes within each run, not absolute latency across runs.</p>'
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>eve loop benchmark report</title>
    <style>${REPORT_CSS}</style>
  </head>
  <body>
    <main>
      <header class="page-header">
        <div>
          <p class="eyebrow">eve loop benchmark</p>
          <h1>Runtime latency report</h1>
        </div>
        <p class="run-count">${String(report.runs.length)} ${report.runs.length === 1 ? "run" : "runs"}</p>
      </header>
      ${mixedModelWarning}
      ${report.runs.map((run, index) => renderRun(run, `run-${String(index + 1)}`)).join("\n")}
    </main>
  </body>
</html>
`;
}

function renderRun(run: BenchmarkReportRun, sectionId: string): string {
  const topology = run.topology ?? "hosted-origins";
  return `<article class="run">
  <header class="run-header">
    <div>
      <p class="source">${run.sourceLabels.map(escapeHtml).join(" + ")}</p>
      <h2>${escapeHtml(run.targetKind)} · ${escapeHtml(run.modelKind)}</h2>
    </div>
    <dl class="metadata">
      <div><dt>Topology</dt><dd>${escapeHtml(topology)}</dd></div>
      <div><dt>Run</dt><dd><code>${escapeHtml(run.runId)}</code></dd></div>
    </dl>
  </header>
  ${renderHealth(run, sectionId)}
  ${renderEndToEnd(run, sectionId)}
  ${renderLayercake(run, sectionId)}
  ${renderOverhead(run, sectionId)}
  ${renderServerIntervals(run, sectionId)}
</article>`;
}

function renderHealth(run: BenchmarkReportRun, sectionId: string): string {
  return `<section aria-labelledby="${sectionId}-health">
  <h3 id="${sectionId}-health">Included samples</h3>
  <div class="health-grid">
    ${BENCHMARK_REPORT_RUNTIMES.map((runtime) => renderRuntimeHealth(run, runtime)).join("\n")}
  </div>
</section>`;
}

function renderRuntimeHealth(run: BenchmarkReportRun, runtime: BenchmarkReportRuntime): string {
  const correctness = run.correctness.measured[runtime];
  const telemetry = run.telemetryStatusCounts.measured[runtime];
  const correctnessTotal = correctness.valid + correctness.invalid + correctness.failed;
  if (correctnessTotal === 0) {
    return `<div class="health-item">
  <div class="health-title"><span class="runtime-dot ${runtime}"></span>${RUNTIME_LABELS[runtime]} <span class="status status-muted">not run</span></div>
  <p>No measured samples</p>
</div>`;
  }

  const telemetryTotal =
    telemetry.complete + telemetry.incomplete + telemetry.failed + telemetry.unavailable;
  const valid = correctness.invalid === 0 && correctness.failed === 0;
  const clientOnly = run.targetKind === "vercel" && run.topology === null;
  const complete = clientOnly || (telemetryTotal > 0 && telemetry.complete === telemetryTotal);
  const statusClass = valid && complete ? "status-ok" : "status-warn";
  const status =
    valid && complete ? (clientOnly ? "client complete" : "complete") : "excluded data";
  const detail = clientOnly
    ? `${String(correctness.valid)}/${String(correctnessTotal)} valid · client timing only`
    : `${String(correctness.valid)}/${String(correctnessTotal)} valid · ${String(telemetry.complete)}/${String(telemetryTotal)} telemetry complete`;

  return `<div class="health-item">
  <div class="health-title"><span class="runtime-dot ${runtime}"></span>${RUNTIME_LABELS[runtime]} <span class="status ${statusClass}">${status}</span></div>
  <p>${detail}</p>
</div>`;
}

function renderEndToEnd(run: BenchmarkReportRun, sectionId: string): string {
  const maxP95 = Math.max(
    1,
    ...BENCHMARK_REPORT_RUNTIMES.map(
      (runtime) => run.runtimes[runtime].e2eSessionWaitingReducedMs?.p95 ?? 0,
    ),
  );

  return `<section aria-labelledby="${sectionId}-e2e">
  <div class="section-heading">
    <div>
      <h3 id="${sectionId}-e2e">End-to-end agent latency</h3>
      <p>Client request start through reducing the terminal <code>session.waiting</code> event.</p>
    </div>
    <div class="legend"><span class="legend-first"></span> first text p50 <span class="legend-fill"></span> completion p50 <span class="legend-tick"></span> p90 / p95</div>
  </div>
  <div class="latency-chart">
    ${BENCHMARK_REPORT_RUNTIMES.map((runtime) => renderLatencyRow(run, runtime, maxP95)).join("\n")}
  </div>
</section>`;
}

function renderLatencyRow(
  run: BenchmarkReportRun,
  runtime: BenchmarkReportRuntime,
  maxP95: number,
): string {
  const completion = run.runtimes[runtime].e2eSessionWaitingReducedMs;
  const firstText = run.runtimes[runtime].firstVisibleTextMs;
  if (completion === null) {
    return `<div class="latency-row"><div class="runtime-name">${RUNTIME_LABELS[runtime]}</div><p class="empty">No valid measured samples</p></div>`;
  }

  const firstTextP50 = firstText?.p50 ?? 0;
  return `<div class="latency-row">
  <div class="runtime-name"><span class="runtime-dot ${runtime}"></span>${RUNTIME_LABELS[runtime]}</div>
  <div class="latency-track ${runtime}" style="--p50:${percent(completion.p50, maxP95)};--p90:${percent(completion.p90, maxP95)};--p95:${percent(completion.p95, maxP95)};--first:${percent(firstTextP50, maxP95)}">
    <span class="p95-range"></span><span class="p50-fill"></span><span class="percentile-tick p90"></span><span class="percentile-tick p95"></span><span class="first-text"></span>
  </div>
  <div class="metric-values"><strong>${formatMs(completion.p50)}</strong><span>p50</span><strong>${formatMs(completion.p95)}</strong><span>p95</span></div>
</div>`;
}

function renderLayercake(run: BenchmarkReportRun, sectionId: string): string {
  return `<section aria-labelledby="${sectionId}-layercake">
  <div class="section-heading">
    <div>
      <h3 id="${sectionId}-layercake">Client-observed request timeline</h3>
      <p>Seven consecutive mean durations from request start through receipt of <code>session.waiting</code>. Read each normalized bar from left to right; the total at right carries magnitude.</p>
    </div>
  </div>
  <div class="layercake">
    ${BENCHMARK_REPORT_RUNTIMES.map((runtime) => renderLayercakeBar(run, runtime)).join("\n")}
  </div>
  ${renderPhaseTable(run)}
  ${renderMarkerSources(sectionId)}
</section>`;
}

function renderLayercakeBar(run: BenchmarkReportRun, runtime: BenchmarkReportRuntime): string {
  const means = run.runtimes[runtime].protocolPhaseMeansMs;
  const values = BENCHMARK_REPORT_PROTOCOL_PHASES.map((phase) => means[phase]);
  const total = values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  if (total === null || total === 0) {
    return `<div class="layer-row"><div class="runtime-name">${RUNTIME_LABELS[runtime]}</div><p class="empty">No complete layercake samples</p></div>`;
  }

  return `<div class="layer-row">
  <div class="runtime-name"><span class="runtime-dot ${runtime}"></span>${RUNTIME_LABELS[runtime]}</div>
  <div class="layer-bar">
    ${BENCHMARK_REPORT_PROTOCOL_PHASES.map((phase, index) => {
      const value = means[phase] ?? 0;
      return `<span class="phase phase-${String(index + 1)}" style="width:${percent(value, total)}" aria-label="${escapeHtml(PHASE_DETAILS[phase].accessibleLabel)}: ${formatMs(value)}"></span>`;
    }).join("")}
  </div>
  <strong class="layer-total">${formatMs(total)}</strong>
</div>`;
}

function renderPhaseTable(run: BenchmarkReportRun): string {
  return `<table class="phase-table">
  <caption class="sr-only">Mean protocol phase duration in milliseconds by runtime</caption>
  <thead><tr><th>Mean phase</th>${BENCHMARK_REPORT_RUNTIMES.map((runtime) => `<th>${RUNTIME_LABELS[runtime]}</th>`).join("")}</tr></thead>
  <tbody>
    ${BENCHMARK_REPORT_PROTOCOL_PHASES.map(
      (phase, index) =>
        `<tr><th><span class="phase-title"><span class="phase-swatch phase-${String(index + 1)}"></span>${PHASE_DETAILS[phase].labelHtml}</span><span class="phase-boundary">${PHASE_DETAILS[phase].boundaryHtml}</span></th>${BENCHMARK_REPORT_RUNTIMES.map((runtime) => `<td>${formatNullableMs(run.runtimes[runtime].protocolPhaseMeansMs[phase])}</td>`).join("")}</tr>`,
    ).join("\n")}
  </tbody>
</table>`;
}

function renderMarkerSources(sectionId: string): string {
  return `<aside class="marker-sources" aria-labelledby="${sectionId}-marker-sources-heading">
  <h4 id="${sectionId}-marker-sources-heading">Marker sources in code</h4>
  <p>All timestamps are captured by <code>runBenchmarkSample()</code> in <code>apps/fixtures/loop-backend-benchmark/src/driver/run-benchmark-sample.ts</code>. The protocol events originate here:</p>
  <dl>
    <div><dt><code>session.started</code></dt><dd><code>emitTurnPreamble()</code> in <code>packages/eve/src/harness/emission.ts</code></dd></div>
    <div><dt><code>actions.requested</code> → <code>action.result</code> → <code>step.completed</code></dt><dd>The streamed benchmark path emits <code>actions.requested</code> and <code>action.result</code> from <code>emitStreamContent()</code> in <code>packages/eve/src/harness/emission.ts</code>. <code>emitStepActions()</code> then emits <code>step.completed</code> from the completed model-step result in <code>packages/eve/src/harness/step-hooks.ts</code>. The tool-call interval therefore includes tool execution and <code>action.result</code> delivery; it is not a separate “tool step.”</dd></div>
    <div><dt>First visible response text</dt><dd><code>emitStreamContent()</code> in <code>packages/eve/src/harness/emission.ts</code> emits streamed text as <code>message.appended</code>; <code>runBenchmarkSample()</code> records the first received event whose client reduction exposes non-empty assistant text</dd></div>
    <div><dt><code>session.waiting</code></dt><dd><code>emitTurnEpilogue()</code> in <code>packages/eve/src/harness/emission.ts</code>. <code>turn.completed</code> is emitted between <code>step.completed(stop)</code> and <code>session.waiting</code>.</dd></div>
  </dl>
</aside>`;
}

function renderOverhead(run: BenchmarkReportRun, sectionId: string): string {
  const summaries = BENCHMARK_REPORT_COMPARISONS.map(
    (comparison) => run.comparisons[comparison].e2eSessionWaitingReducedMs,
  );
  const maxAbsolute = Math.max(
    1,
    ...summaries.flatMap((summary) =>
      summary === null ? [] : [Math.abs(summary.p50), Math.abs(summary.p90), Math.abs(summary.p95)],
    ),
  );

  return `<section aria-labelledby="${sectionId}-overhead">
  <div class="section-heading">
    <div>
      <h3 id="${sectionId}-overhead">Paired implementation delta</h3>
      <p>Matched-block completion latency relative to inline. Positive values are slower.</p>
    </div>
  </div>
  <div class="delta-chart">
    ${BENCHMARK_REPORT_COMPARISONS.map((comparison) => renderDeltaRow(run, comparison, maxAbsolute)).join("\n")}
  </div>
</section>`;
}

function renderDeltaRow(
  run: BenchmarkReportRun,
  comparison: BenchmarkReportComparison,
  maxAbsolute: number,
): string {
  const summary = run.comparisons[comparison].e2eSessionWaitingReducedMs;
  if (summary === null) {
    return `<div class="delta-row"><div class="comparison-name">${COMPARISON_LABELS[comparison]}</div><p class="empty">No matched valid blocks</p></div>`;
  }

  const p50Position = deltaPosition(summary.p50, maxAbsolute);
  const left = Math.min(50, p50Position);
  const width = Math.abs(p50Position - 50);
  return `<div class="delta-row">
  <div class="comparison-name">${COMPARISON_LABELS[comparison]}</div>
  <div class="delta-track ${comparison.startsWith("workflow") ? "workflow" : "temporal"}">
    <span class="zero"></span><span class="delta-fill" style="left:${String(left)}%;width:${String(width)}%"></span><span class="delta-p95" style="left:${String(deltaPosition(summary.p95, maxAbsolute))}%"></span>
  </div>
  <div class="metric-values"><strong>${formatSignedMs(summary.p50)}</strong><span>p50</span><strong>${formatSignedMs(summary.p95)}</strong><span>p95</span></div>
</div>`;
}

function renderServerIntervals(run: BenchmarkReportRun, sectionId: string): string {
  const names = new Set<string>();
  for (const runtime of BENCHMARK_REPORT_RUNTIMES) {
    for (const name of Object.keys(run.runtimes[runtime].serverIntervalPercentilesMsByName)) {
      names.add(name);
    }
  }
  const sortedNames = [...names].toSorted();
  const content =
    sortedNames.length === 0
      ? '<p class="empty block-empty">No complete server telemetry for this run.</p>'
      : `<div class="interval-list">${sortedNames.map((name) => renderInterval(run, name)).join("\n")}</div>`;

  return `<section aria-labelledby="${sectionId}-server">
  <div class="section-heading">
    <div>
      <h3 id="${sectionId}-server">Neutral server intervals</h3>
      <p>Per-sample summed interval p50s. Intervals are independent and may overlap; they are not a stack.</p>
    </div>
  </div>
  ${content}
</section>`;
}

function renderInterval(run: BenchmarkReportRun, name: string): string {
  const runtimeValues = BENCHMARK_REPORT_RUNTIMES.map((runtime) => ({
    label: RUNTIME_LABELS[runtime],
    value: run.runtimes[runtime].serverIntervalPercentilesMsByName[name]?.p50 ?? null,
  }));
  const comparisonValues = BENCHMARK_REPORT_COMPARISONS.map((comparison) => ({
    label: COMPARISON_LABELS[comparison],
    value: run.comparisons[comparison].serverIntervalPercentilesMsByName[name]?.p50 ?? null,
  }));
  return `<div class="interval-row">
  <code class="interval-name">${escapeHtml(name)}</code>
  <div class="interval-values">
    ${runtimeValues.map((item) => `<span><small>${item.label}</small>${formatNullableMs(item.value)}</span>`).join("")}
    ${comparisonValues.map((item) => `<span class="delta-value"><small>${item.label}</small>${formatNullableSignedMs(item.value)}</span>`).join("")}
  </div>
</div>`;
}

function percent(value: number, maximum: number): string {
  return `${String(Math.min(100, Math.max(0, (value / maximum) * 100)))}%`;
}

function deltaPosition(value: number, maximumAbsolute: number): number {
  return Math.min(100, Math.max(0, 50 + (value / maximumAbsolute) * 50));
}

function formatNullableMs(value: number | null): string {
  return value === null ? "—" : formatMs(value);
}

function formatNullableSignedMs(value: number | null): string {
  return value === null ? "—" : formatSignedMs(value);
}

function formatSignedMs(value: number): string {
  if (value === 0) return formatMs(0);
  return `${value > 0 ? "+" : "−"}${formatMs(Math.abs(value))}`;
}

function formatMs(value: number): string {
  const absolute = Math.abs(value);
  const digits = absolute >= 100 ? 1 : absolute >= 10 ? 2 : absolute >= 1 ? 2 : 3;
  return `${value.toFixed(digits)} ms`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const REPORT_CSS = `
:root {
  color-scheme: light dark;
  --bg: #fafafa;
  --fg: #171717;
  --muted: #666;
  --subtle: #f1f1f1;
  --border: #dedede;
  --inline: #2563eb;
  --workflow: #7c3aed;
  --temporal: #db2777;
  --ok: #15803d;
  --warn: #b45309;
  --phase-1: #1d4ed8;
  --phase-2: #0369a1;
  --phase-3: #0f766e;
  --phase-4: #4d7c0f;
  --phase-5: #a16207;
  --phase-6: #c2410c;
  --phase-7: #be123c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0a0a;
    --fg: #f5f5f5;
    --muted: #a3a3a3;
    --subtle: #191919;
    --border: #303030;
    --inline: #60a5fa;
    --workflow: #a78bfa;
    --temporal: #f472b6;
    --ok: #4ade80;
    --warn: #fbbf24;
    --phase-1: #60a5fa;
    --phase-2: #38bdf8;
    --phase-3: #2dd4bf;
    --phase-4: #a3e635;
    --phase-5: #facc15;
    --phase-6: #fb923c;
    --phase-7: #fb7185;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(1120px, 100%); margin: 0 auto; padding: 40px 24px 72px; }
h1, h2, h3, h4, p { margin-top: 0; }
h1 { margin-bottom: 0; font-size: clamp(1.7rem, 4vw, 2.5rem); font-weight: 500; letter-spacing: -0.035em; }
h2 { margin-bottom: 0; font-size: 1.35rem; font-weight: 500; }
h3 { margin-bottom: 4px; font-size: 1rem; font-weight: 500; }
h4 { margin-bottom: 6px; font-size: .86rem; font-weight: 500; }
code { font: 0.88em ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.page-header, .run-header, .section-heading { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
.page-header { align-items: end; margin-bottom: 24px; }
.eyebrow, .source { margin-bottom: 5px; color: var(--muted); font-size: .76rem; font-weight: 500; letter-spacing: .09em; text-transform: uppercase; }
.run-count { margin: 0; color: var(--muted); }
.warning { padding: 10px 12px; border-left: 3px solid var(--warn); background: var(--subtle); }
.run { padding: 30px 0; border-top: 1px solid var(--border); }
.run + .run { margin-top: 26px; }
.metadata { display: grid; gap: 7px; margin: 0; text-align: right; }
.metadata div { display: flex; justify-content: flex-end; gap: 8px; }
.metadata dt { color: var(--muted); }
.metadata dd { margin: 0; }
section { margin-top: 32px; }
.section-heading { margin-bottom: 16px; }
.section-heading p { max-width: 680px; margin-bottom: 0; color: var(--muted); }
.health-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; padding: 14px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.health-title { display: flex; align-items: center; gap: 7px; font-weight: 500; }
.health-item p { margin: 4px 0 0 17px; color: var(--muted); font-size: .82rem; }
.runtime-dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
.runtime-dot.inline, .latency-track.inline { color: var(--inline); }
.runtime-dot.workflow, .latency-track.workflow { color: var(--workflow); }
.runtime-dot.temporal, .latency-track.temporal { color: var(--temporal); }
.status { margin-left: auto; color: var(--muted); font-size: .72rem; font-weight: 400; }
.status-ok { color: var(--ok); }
.status-warn { color: var(--warn); }
.status-muted { color: var(--muted); }
.legend { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; color: var(--muted); font-size: .75rem; }
.legend-first, .legend-fill, .legend-tick { display: inline-block; width: 10px; height: 10px; margin-left: 4px; }
.legend-first { transform: rotate(45deg); border: 1.5px solid var(--fg); background: var(--bg); }
.legend-fill { background: var(--fg); opacity: .65; }
.legend-tick { width: 1px; background: var(--fg); }
.latency-chart, .delta-chart, .layercake { display: grid; gap: 14px; }
.latency-row, .delta-row, .layer-row { display: grid; grid-template-columns: 118px minmax(120px, 1fr) 190px; gap: 14px; align-items: center; }
.runtime-name { display: flex; align-items: center; gap: 7px; font-weight: 500; }
.latency-track, .delta-track { position: relative; height: 22px; background: var(--subtle); }
.p95-range, .p50-fill { position: absolute; left: 0; top: 0; height: 100%; min-width: 2px; background: currentColor; }
.p95-range { width: var(--p95); opacity: .16; }
.p50-fill { width: var(--p50); opacity: .62; }
.percentile-tick, .first-text { position: absolute; top: -3px; width: 2px; height: 28px; background: currentColor; }
.p90 { left: var(--p90); opacity: .55; }
.p95 { left: var(--p95); }
.first-text { left: var(--first); top: 6px; width: 10px; height: 10px; border: 2px solid currentColor; background: var(--bg); transform: translateX(-5px) rotate(45deg); }
.metric-values { display: grid; grid-template-columns: auto auto auto auto; align-items: baseline; gap: 4px 7px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.metric-values strong { font-weight: 500; text-align: right; }
.metric-values span { color: var(--muted); font-size: .72rem; }
.layer-bar { display: flex; height: 28px; overflow: hidden; background: var(--subtle); }
.phase { min-width: 1px; }
.phase-1 { background: var(--phase-1); }
.phase-2 { background: var(--phase-2); }
.phase-3 { background: var(--phase-3); }
.phase-4 { background: var(--phase-4); }
.phase-5 { background: var(--phase-5); }
.phase-6 { background: var(--phase-6); }
.phase-7 { background: var(--phase-7); }
.layer-total { font-weight: 500; font-variant-numeric: tabular-nums; }
.phase-table { width: 100%; margin-top: 18px; border-collapse: collapse; table-layout: fixed; font-size: .82rem; }
.phase-table th, .phase-table td { padding: 7px 8px; border-bottom: 1px solid var(--border); text-align: right; font-variant-numeric: tabular-nums; }
.phase-table th:first-child { width: 58%; text-align: left; font-weight: 400; }
.phase-table thead th { color: var(--muted); font-weight: 500; }
.phase-title { display: block; }
.phase-boundary { display: block; margin: 2px 0 0 17px; color: var(--muted); font-size: .72rem; font-weight: 400; line-height: 1.4; }
.phase-swatch { display: inline-block; width: 9px; height: 9px; margin-right: 8px; }
.marker-sources { margin-top: 20px; padding: 14px 16px; background: var(--subtle); }
.marker-sources > p { margin-bottom: 12px; color: var(--muted); font-size: .78rem; }
.marker-sources dl { display: grid; gap: 8px; margin: 0; }
.marker-sources dl div { display: grid; grid-template-columns: minmax(190px, 1fr) 2.4fr; gap: 14px; }
.marker-sources dt, .marker-sources dd { margin: 0; }
.marker-sources dt { font-size: .78rem; font-weight: 500; }
.marker-sources dd { color: var(--muted); font-size: .78rem; }
.delta-track { color: var(--fg); }
.delta-track.workflow { color: var(--workflow); }
.delta-track.temporal { color: var(--temporal); }
.zero { position: absolute; left: 50%; top: -4px; width: 1px; height: 30px; background: var(--border); }
.delta-fill { position: absolute; top: 0; height: 100%; min-width: 2px; background: currentColor; opacity: .65; }
.delta-p95 { position: absolute; top: -3px; width: 2px; height: 28px; background: currentColor; }
.comparison-name { font-weight: 500; }
.interval-list { border-top: 1px solid var(--border); }
.interval-row { display: grid; grid-template-columns: minmax(150px, 1fr) 3fr; gap: 18px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border); }
.interval-values { display: grid; grid-template-columns: repeat(5, minmax(80px, 1fr)); gap: 10px; font-variant-numeric: tabular-nums; }
.interval-values span { display: grid; }
.interval-values small { color: var(--muted); font-size: .68rem; }
.delta-value { border-left: 1px solid var(--border); padding-left: 10px; }
.empty { margin: 0; color: var(--muted); }
.block-empty { padding: 14px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 760px) {
  main { padding: 28px 16px 48px; }
  .run-header, .section-heading { display: block; }
  .metadata { margin-top: 14px; text-align: left; }
  .metadata div { justify-content: flex-start; }
  .legend { justify-content: flex-start; margin-top: 10px; }
  .health-grid { grid-template-columns: 1fr; gap: 12px; }
  .latency-row, .delta-row, .layer-row { grid-template-columns: 100px minmax(100px, 1fr); }
  .metric-values, .layer-total { grid-column: 2; }
  .metric-values { justify-content: start; }
  .interval-row { grid-template-columns: 1fr; gap: 8px; }
  .interval-values { grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); }
  .marker-sources dl div { grid-template-columns: 1fr; gap: 2px; }
}
@media (max-width: 460px) {
  .page-header { display: block; }
  .run-count { margin-top: 8px; }
  .latency-row, .delta-row, .layer-row { grid-template-columns: 1fr; gap: 7px; }
  .metric-values, .layer-total { grid-column: 1; }
  .phase-table { font-size: .72rem; }
  .phase-table th, .phase-table td { padding: 6px 3px; }
  .phase-table th:first-child { width: 58%; }
  .phase-swatch { width: 7px; height: 7px; margin-right: 5px; }
  .phase-boundary { margin-left: 12px; }
}
`;
