import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CapturedAttributeValue, CapturedSpan } from "#internal/tracing/captured-span.js";
import { createLogger } from "#internal/logging.js";
import {
  capturedSpansToOtlp,
  otlpToCapturedSpans,
  type OtlpTracePayload,
} from "#internal/tracing/otlp.js";
import { projectRunSummary, type RunSummary } from "#internal/tracing/projection.js";

const log = createLogger("tracing.store");

const TRACE_DIRECTORY_SEGMENTS = [".eve", "traces"] as const;
const OTLP_SUFFIX = ".otlp.json";
const SUMMARY_FILE = "summary.json";
const DEFAULT_MAX_TRACES = 200;

/** Filesystem-safe name for a run id or segment id used as a path component. */
function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/** Merges span lists, keeping the first occurrence of each span id. */
function mergeSpansById(spans: readonly CapturedSpan[]): CapturedSpan[] {
  const seen = new Set<string>();
  const result: CapturedSpan[] = [];
  for (const span of spans) {
    if (seen.has(span.spanId)) continue;
    seen.add(span.spanId);
    result.push(span);
  }
  return result;
}

/**
 * Durable, on-disk store for captured dev traces under `.eve/traces`.
 *
 * A run (one session) is a subdirectory; each captured step root writes its own
 * OTLP/JSON **segment** file (`<runId>/<rootSpanId>.otlp.json`). Segments are
 * append-only and uniquely named, so durable steps running in separate processes
 * never race on a shared file — reads simply merge a run's segments. Retention is
 * bounded by run count; evicted runs are logged, never dropped silently.
 *
 * Each write also refreshes a small `<runId>/summary.json` sidecar holding the
 * projected {@link RunSummary}. `list()` reads only those sidecars, so listing
 * stays cheap regardless of how large the underlying traces grow — it never has
 * to parse and rehydrate every span of every run just to print a table.
 */
export class TraceStore {
  readonly #directory: string;
  readonly #maxTraces: number;

  constructor(appRoot: string, options: { maxTraces?: number } = {}) {
    this.#directory = join(appRoot, ...TRACE_DIRECTORY_SEGMENTS);
    this.#maxTraces = options.maxTraces ?? DEFAULT_MAX_TRACES;
  }

  /** The absolute `.eve/traces` directory this store manages. */
  get directory(): string {
    return this.#directory;
  }

  /**
   * Persists one captured step root and its subtree as an OTLP/JSON segment of
   * the run `runId`. Writing another segment for the same run accumulates it.
   */
  async write(
    runId: string,
    spans: readonly CapturedSpan[],
    resourceAttributes: Readonly<Record<string, CapturedAttributeValue>> = {},
  ): Promise<void> {
    if (spans.length === 0) return;
    const runDir = join(this.#directory, safeName(runId));
    await mkdir(runDir, { recursive: true });
    const segmentId = spans[0]!.spanId;
    const payload = capturedSpansToOtlp(spans, resourceAttributes);
    await writeFile(
      join(runDir, `${safeName(segmentId)}${OTLP_SUFFIX}`),
      JSON.stringify(payload),
      "utf8",
    );
    await this.#refreshSummary(runId);
    await this.#enforceRetention();
  }

  /**
   * All run summaries, most recent first. Reads each run's `summary.json`
   * sidecar; a run missing one (e.g. captured before sidecars existed) is
   * summarized from its segments and its sidecar backfilled so the next list
   * is cheap.
   */
  async list(): Promise<RunSummary[]> {
    const runIds = await this.#listRunIds();
    const summaries: RunSummary[] = [];
    for (const runId of runIds) {
      const summary = (await this.#readSummary(runId)) ?? (await this.#refreshSummary(runId));
      if (summary !== undefined) summaries.push(summary);
    }
    return summaries.sort((a, b) => b.startedAtMillis - a.startedAtMillis);
  }

  /** The merged captured spans for one run, or `undefined` if unknown. */
  async read(runId: string): Promise<CapturedSpan[] | undefined> {
    const runDir = join(this.#directory, safeName(runId));
    let names: string[];
    try {
      names = await readdir(runDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const spans: CapturedSpan[] = [];
    for (const name of names.filter((entry) => entry.endsWith(OTLP_SUFFIX)).sort()) {
      try {
        const payload = JSON.parse(await readFile(join(runDir, name), "utf8")) as OtlpTracePayload;
        spans.push(...otlpToCapturedSpans(payload));
      } catch {
        // Skip a corrupt segment rather than failing the whole run.
      }
    }
    return spans.length > 0 ? mergeSpansById(spans) : undefined;
  }

  /** The merged OTLP/JSON payload for one run, or `undefined` if unknown. */
  async readOtlp(runId: string): Promise<OtlpTracePayload | undefined> {
    const spans = await this.read(runId);
    return spans === undefined ? undefined : capturedSpansToOtlp(spans);
  }

  /** Deletes every persisted run. Used by tests and cleanup. */
  async clear(): Promise<void> {
    await rm(this.#directory, { recursive: true, force: true });
  }

  /**
   * Recomputes and persists a run's `summary.json` from its merged segments,
   * returning the summary (or `undefined` when the run has no spans). Kept off
   * the `list()` path so writing a segment stays O(one run), not O(all runs).
   */
  async #refreshSummary(runId: string): Promise<RunSummary | undefined> {
    const spans = await this.read(runId);
    if (spans === undefined || spans.length === 0) return undefined;
    const summary: RunSummary = { ...projectRunSummary(spans), traceId: runId };
    await writeFile(
      join(this.#directory, safeName(runId), SUMMARY_FILE),
      JSON.stringify(summary),
      "utf8",
    );
    return summary;
  }

  /** The persisted summary sidecar for a run, or `undefined` if absent/corrupt. */
  async #readSummary(runId: string): Promise<RunSummary | undefined> {
    try {
      const raw = await readFile(join(this.#directory, safeName(runId), SUMMARY_FILE), "utf8");
      return JSON.parse(raw) as RunSummary;
    } catch {
      return undefined;
    }
  }

  async #listRunIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.#directory, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #enforceRetention(): Promise<void> {
    const summaries = await this.list();
    if (summaries.length <= this.#maxTraces) return;
    const evicted = summaries.slice(this.#maxTraces);
    for (const entry of evicted) {
      await rm(join(this.#directory, safeName(entry.traceId)), { recursive: true, force: true });
    }
    log.debug("evicted runs past retention cap", {
      count: evicted.length,
      maxTraces: this.#maxTraces,
    });
  }
}
