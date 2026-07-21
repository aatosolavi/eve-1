import fs from "node:fs";
import path from "node:path";

const usageFields = [
  "totalTokens",
  "totalInputTokens",
  "inputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "outputTokens",
];

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatInteger(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatDelta(value, formatter = formatInteger) {
  if (value === 0) return formatter(0);
  return `${value > 0 ? "+" : "-"}${formatter(Math.abs(value))}`;
}

function printTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const formatRow = (row) =>
    row
      .map((cell, index) =>
        index <= (headers[0] === "Snapshot" ? 1 : 0)
          ? cell.padEnd(widths[index])
          : cell.padStart(widths[index]),
      )
      .join("  ");

  console.log(formatRow(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(formatRow(row));
}

function summarize(results) {
  const passed = results.filter((result) => result.status === "passed").length;
  const usages = results
    .map((result) => result.analysis?.tokenUsage)
    .filter((usage) => usage !== undefined);
  const usage =
    usages.length === 0
      ? undefined
      : Object.fromEntries(
          usageFields.map((field) => [field, mean(usages.map((entry) => entry[field]))]),
        );

  return {
    passed,
    runs: results.length,
    accuracy: (passed / results.length) * 100,
    duration: mean(results.map((result) => result.duration)),
    usageRuns: usages.length,
    usage,
  };
}

function resultRow(label, treatment, summary, comparison) {
  const prefix = comparison ? [label, treatment] : [treatment];
  const usage = summary.usage;
  return [
    ...prefix,
    `${summary.passed}/${summary.runs} (${Math.round(summary.accuracy)}%)`,
    `${summary.usageRuns}/${summary.runs}`,
    ...usageFields.map((field) => (usage === undefined ? "—" : formatInteger(usage[field]))),
    `${summary.duration.toFixed(1)}s`,
  ];
}

function deltaRow(treatment, reference, current) {
  return [
    "Δ",
    treatment,
    `${formatDelta(current.accuracy - reference.accuracy, (value) => value.toFixed(0))} pp`,
    "—",
    ...usageFields.map((field) => {
      if (reference.usage === undefined || current.usage === undefined) return "—";
      return formatDelta(current.usage[field] - reference.usage[field]);
    }),
    `${formatDelta(current.duration - reference.duration, (value) => value.toFixed(1))}s`,
  ];
}

export function buildComparisonRows(treatments, summaries) {
  const rows = [];
  for (const treatment of treatments) {
    const reference = summaries.get(`reference-${treatment}`);
    const current = summaries.get(`current-${treatment}`);
    if (reference !== undefined) rows.push(resultRow("reference", treatment, reference, true));
    if (current !== undefined) rows.push(resultRow("current", treatment, current, true));
    if (reference !== undefined && current !== undefined) {
      rows.push(deltaRow(treatment, reference, current));
    }
  }
  return rows;
}

export function printResultSummary({ resultFiles, resultsDir, experiments, comparison }) {
  if (resultFiles.length === 0) return;

  const resultsByExperiment = new Map();
  for (const resultFile of resultFiles) {
    const experiment = path.relative(resultsDir, resultFile).split(path.sep)[0];
    const results = resultsByExperiment.get(experiment) ?? [];
    results.push(JSON.parse(fs.readFileSync(resultFile, "utf8")));
    resultsByExperiment.set(experiment, results);
  }

  const summaries = new Map();
  for (const experiment of experiments) {
    const results = resultsByExperiment.get(experiment.suffix);
    if (results !== undefined) summaries.set(experiment.suffix, summarize(results));
  }

  const metricHeaders = [
    "Accuracy",
    "Token runs",
    "Total",
    "Input",
    "Uncached",
    "Cache write",
    "Cache read",
    "Output",
    "Duration",
  ];

  console.log("\nEvaluation summary (token counts are means per reported run):");
  if (!comparison) {
    const rows = experiments.flatMap((experiment) => {
      const summary = summaries.get(experiment.suffix);
      return summary === undefined
        ? []
        : [resultRow("current", experiment.treatment, summary, false)];
    });
    printTable(["Variant", ...metricHeaders], rows);
    return;
  }

  const treatments = new Set(experiments.map((experiment) => experiment.treatment));
  const rows = buildComparisonRows(treatments, summaries);
  printTable(["Snapshot", "Variant", ...metricHeaders], rows);
}
