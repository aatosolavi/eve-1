import {
  projectWaterfall,
  TraceStore,
  type OtlpTracePayload,
  type RunSummary,
  type WaterfallNode,
} from "#internal/tracing/index.js";

interface CliTraceLogger {
  error(message: string): void;
  log(message: string): void;
}

const TRACE_DISPLAY_DIRECTORY = ".eve/traces";

/**
 * Resolves a user-supplied trace reference to one id. Accepts the full trace id
 * or any unambiguous prefix; an ambiguous or unknown reference throws with the
 * candidates so the caller can retry with a longer prefix.
 */
export function resolveTraceId(summaries: readonly RunSummary[], reference: string): string {
  const exact = summaries.find((summary) => summary.traceId === reference);
  if (exact !== undefined) return exact.traceId;

  const matches = summaries.filter((summary) => summary.traceId.startsWith(reference));
  if (matches.length === 1) return matches[0]!.traceId;
  if (matches.length === 0) {
    throw new Error(
      `No trace matches "${reference}". Run \`eve trace ls\` to see available traces.`,
    );
  }
  throw new Error(
    [
      `"${reference}" matches ${matches.length} traces:`,
      ...matches.map((summary) => `  ${summary.traceId}`),
      "Pass a longer prefix or the full id.",
    ].join("\n"),
  );
}

function formatDuration(millis: number): string {
  if (millis < 1000) return `${Math.round(millis)}ms`;
  return `${(millis / 1000).toFixed(2)}s`;
}

/**
 * Readable absolute start time, e.g. `2026-07-22 19:01:39` (UTC). Trims the
 * ISO string's `T` separator, fractional seconds, and trailing `Z` — noise that
 * makes the column hard to scan without helping a human read it.
 */
function formatStarted(millis: number): string {
  return new Date(millis)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}

/**
 * Renders the runs table (one row per session, most-recent first) as lines,
 * kept pure so the column layout can be asserted without the filesystem. A run
 * is keyed by its eve session id, so that id is shown in full under `SESSION`.
 */
export function formatRunList(summaries: readonly RunSummary[]): string[] {
  const header = ["SESSION", "TRIGGER", "TURNS", "TKNS IN", "TKNS OUT", "DURATION", "STARTED"];
  const rows = summaries.map((summary) => [
    summary.traceId,
    summary.trigger ?? "-",
    String(summary.turnCount),
    String(summary.inputTokens),
    String(summary.outputTokens),
    formatDuration(summary.durationMillis),
    formatStarted(summary.startedAtMillis),
  ]);

  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]!.length)),
  );
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join("  ")
      .trimEnd();

  return [render(header), ...rows.map(render)];
}

const WATERFALL_WIDTH = 40;

/**
 * Renders a captured run's span tree as terminal waterfall lines: each node is
 * indented by its `depth`, drawn as a proportional bar (`█` span over a `░`
 * track) positioned by `offsetPct`/`widthPct`, then its name and duration. Pure
 * so the bar geometry can be asserted without the filesystem.
 */
export function formatWaterfall(nodes: readonly WaterfallNode[]): string[] {
  return nodes.map((node) => {
    const start = Math.round((node.offsetPct / 100) * WATERFALL_WIDTH);
    const width = Math.max(1, Math.round((node.widthPct / 100) * WATERFALL_WIDTH));
    const end = Math.min(WATERFALL_WIDTH, start + width);

    const track = Array.from({ length: WATERFALL_WIDTH }, (_, column) =>
      column >= start && column < end ? "█" : "░",
    ).join("");

    const indent = "  ".repeat(node.depth);
    return `${track} ${indent}${node.name} ${formatDuration(node.durationMillis)}`;
  });
}

/** Options accepted by {@link runTraceListCommand}. */
export interface TraceListCommandOptions {
  /** Emit the raw `RunSummary[]` as JSON instead of the human table. */
  json?: boolean;
}

/** `eve trace ls`: lists captured runs, most recent first. */
export async function runTraceListCommand(
  logger: CliTraceLogger,
  appRoot: string,
  options: TraceListCommandOptions = {},
): Promise<void> {
  const summaries = await new TraceStore(appRoot).list();

  if (options.json) {
    logger.log(JSON.stringify(summaries, null, 2));
    return;
  }

  if (summaries.length === 0) {
    logger.log(`No traces found under ${TRACE_DISPLAY_DIRECTORY}.`);
    return;
  }

  for (const line of formatRunList(summaries)) logger.log(line);
}

/** Options accepted by {@link runTraceShowCommand}. */
export interface TraceShowCommandOptions {
  /** Dump the trace's raw OTLP/JSON payload instead of the waterfall. */
  json?: boolean;
}

/**
 * `eve trace show [traceId]`: renders a run's waterfall — the most recent when
 * `traceId` is omitted, else the trace matching that id or unambiguous prefix.
 * With `--json`, the raw OTLP/JSON payload is printed instead.
 */
export async function runTraceShowCommand(
  logger: CliTraceLogger,
  appRoot: string,
  traceId?: string,
  options: TraceShowCommandOptions = {},
): Promise<void> {
  const store = new TraceStore(appRoot);
  const summaries = await store.list();
  if (summaries.length === 0) {
    const message = `No traces found under ${TRACE_DISPLAY_DIRECTORY}.`;
    if (traceId !== undefined) throw new Error(message);
    logger.log(message);
    return;
  }

  const resolved =
    traceId === undefined ? summaries[0]!.traceId : resolveTraceId(summaries, traceId);

  if (options.json) {
    const otlp = await store.readOtlp(resolved);
    if (otlp === undefined) throw new Error(`Trace "${resolved}" has no stored OTLP payload.`);
    logger.log(JSON.stringify(otlp, null, 2));
    return;
  }

  const spans = await store.read(resolved);
  if (spans === undefined || spans.length === 0) {
    throw new Error(`Trace "${resolved}" has no captured spans.`);
  }

  for (const line of formatWaterfall(projectWaterfall(spans))) logger.log(line);
}

async function fetchPoster(url: string, body: string): Promise<{ status: number }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: response.status };
}

/** Options accepted by {@link runTraceExportCommand}. */
export interface TraceExportCommandOptions {
  /** OTLP/HTTP endpoint to POST the trace to; prints to stdout when omitted. */
  otlp?: string;
  /** Injectable HTTP poster; defaults to a `fetch`-based implementation. */
  post?: (url: string, body: string) => Promise<{ status: number }>;
}

/**
 * `eve trace export <traceId>`: emits a trace's stored OTLP/JSON payload. With
 * `--otlp <url>`, it is POSTed to that OTLP/HTTP endpoint and the response
 * status is reported; otherwise the payload is printed to stdout.
 */
export async function runTraceExportCommand(
  logger: CliTraceLogger,
  appRoot: string,
  traceId: string,
  options: TraceExportCommandOptions = {},
): Promise<void> {
  const otlp = await new TraceStore(appRoot).readOtlp(traceId);
  if (otlp === undefined) {
    throw new Error(`No trace matches "${traceId}". Run \`eve trace ls\` to see available traces.`);
  }

  const body = JSON.stringify(otlp satisfies OtlpTracePayload);

  if (options.otlp === undefined) {
    logger.log(body);
    return;
  }

  const post = options.post ?? fetchPoster;
  const { status } = await post(options.otlp, body);
  logger.log(`Exported trace ${traceId} to ${options.otlp} (HTTP ${status}).`);
}
