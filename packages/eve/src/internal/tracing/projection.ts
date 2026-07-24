import {
  readEveAttribute,
  type CapturedAttributeValue,
  type CapturedSpan,
} from "#internal/tracing/captured-span.js";

/** A one-line summary of a captured run, for the runs list and `eve trace ls`. */
export interface RunSummary {
  readonly traceId: string;
  readonly sessionId?: string;
  readonly trigger?: string;
  readonly rootName: string;
  readonly turnCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly totalTokens: number;
  readonly durationMillis: number;
  readonly startedAtMillis: number;
  readonly spanCount: number;
}

/** A span placed in the run's timeline, with geometry for the waterfall bar. */
export interface WaterfallNode {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly depth: number;
  /** Left edge as a percentage [0,100] of the run's total span. */
  readonly offsetPct: number;
  /** Width as a percentage (0,100] of the run's total span. */
  readonly widthPct: number;
  readonly durationMillis: number;
  /** Absolute wall-clock start/end (epoch ms) so a viewer can lay the span out
   * against a live-advancing window, not just the run's window at capture time. */
  readonly startMillis: number;
  readonly endMillis: number;
  readonly attributes: Readonly<Record<string, CapturedAttributeValue>>;
  /** Span status (`code` 2 is error); present so a viewer can flag failures. */
  readonly status?: { readonly code: number; readonly message?: string };
}

function readNumber(value: CapturedAttributeValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function firstNumberAttribute(span: CapturedSpan, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(span.attributes[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** First span carrying the given `eve.<key>` (bare or AI-SDK-prefixed). */
function firstEveAttribute(spans: readonly CapturedSpan[], key: string): string | undefined {
  for (const span of spans) {
    const value = readEveAttribute(span.attributes, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

const INPUT_TOKEN_KEYS = [
  "gen_ai.usage.input_tokens",
  "ai.usage.inputTokens",
  "ai.usage.promptTokens",
];
const OUTPUT_TOKEN_KEYS = [
  "gen_ai.usage.output_tokens",
  "ai.usage.outputTokens",
  "ai.usage.completionTokens",
];
const CACHED_TOKEN_KEYS = [
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cached_input_tokens",
  "ai.usage.cachedInputTokens",
];

const ALL_TOKEN_KEYS = [...INPUT_TOKEN_KEYS, ...OUTPUT_TOKEN_KEYS, ...CACHED_TOKEN_KEYS];

function hasUsage(span: CapturedSpan): boolean {
  return ALL_TOKEN_KEYS.some((key) => typeof span.attributes[key] === "number");
}

/**
 * The deepest usage-bearing spans in a run — the actual model calls.
 *
 * The AI SDK renames model spans to GenAI conventions (`invoke_agent` wrapping
 * `chat`), and the wrapper often carries an aggregate copy of its child's usage.
 * Keeping only usage spans that are not an ancestor of another usage span sums
 * each model call exactly once, whatever the span names are.
 */
function modelCallSpans(spans: readonly CapturedSpan[]): CapturedSpan[] {
  const usageSpans = spans.filter(hasUsage);
  if (usageSpans.length <= 1) return usageSpans;
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const aggregateIds = new Set<string>();
  for (const span of usageSpans) {
    let parentId = span.parentSpanId;
    while (parentId !== undefined) {
      aggregateIds.add(parentId);
      parentId = byId.get(parentId)?.parentSpanId;
    }
  }
  return usageSpans.filter((span) => !aggregateIds.has(span.spanId));
}

/** Computes a {@link RunSummary} from a run's captured spans. */
export function projectRunSummary(spans: readonly CapturedSpan[]): RunSummary {
  if (spans.length === 0) {
    throw new Error("projectRunSummary requires at least one span.");
  }

  const traceId = spans[0]!.traceId;
  const startedAtMillis = Math.min(...spans.map((span) => span.startMillis));
  const endMillis = Math.max(...spans.map((span) => span.endMillis));

  const usageSpans = modelCallSpans(spans);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  for (const span of usageSpans) {
    inputTokens += firstNumberAttribute(span, INPUT_TOKEN_KEYS) ?? 0;
    outputTokens += firstNumberAttribute(span, OUTPUT_TOKEN_KEYS) ?? 0;
    cachedTokens += firstNumberAttribute(span, CACHED_TOKEN_KEYS) ?? 0;
  }

  // A turn may span several durable steps; count distinct turn ids so a
  // multi-step turn is one turn, not one per step.
  const distinctTurnIds = new Set(
    spans.map((span) => readEveAttribute(span.attributes, "turn.id")).filter(isDefined),
  );
  const turnSpanCount = spans.filter((span) => span.name === "ai.eve.turn").length;
  const turnCount = Math.max(distinctTurnIds.size, turnSpanCount, 1);

  const roots = spans.filter((span) => span.parentSpanId === undefined);
  const rootName = (roots[0] ?? spans[0]!).name;

  return {
    traceId,
    sessionId: firstEveAttribute(spans, "session.id"),
    trigger: firstEveAttribute(spans, "channel.kind"),
    rootName,
    turnCount,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
    durationMillis: endMillis - startedAtMillis,
    startedAtMillis,
    spanCount: spans.length,
  };
}

/**
 * Orders a run's spans into a depth-first waterfall with per-span geometry.
 *
 * Offsets and widths are percentages of the run's wall-clock span (earliest
 * start to latest end), so a renderer can place bars without knowing absolute
 * times. Children are ordered by start time; orphaned spans (parent not in the
 * set) are treated as roots so nothing is dropped.
 */
export function projectWaterfall(spans: readonly CapturedSpan[]): WaterfallNode[] {
  if (spans.length === 0) return [];

  const runStart = Math.min(...spans.map((span) => span.startMillis));
  const runEnd = Math.max(...spans.map((span) => span.endMillis));
  const runDuration = Math.max(runEnd - runStart, 1);

  const byId = new Map(spans.map((span) => [span.spanId, span]));

  const childrenByParent = new Map<string | undefined, CapturedSpan[]>();
  for (const span of spans) {
    // Orphaned spans (parent not in the set) are treated as roots.
    const parentKey =
      span.parentSpanId !== undefined && byId.has(span.parentSpanId)
        ? span.parentSpanId
        : undefined;
    const siblings = childrenByParent.get(parentKey) ?? [];
    siblings.push(span);
    childrenByParent.set(parentKey, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => a.startMillis - b.startMillis);
  }

  const nodes: WaterfallNode[] = [];
  const visit = (span: CapturedSpan, depth: number): void => {
    const durationMillis = span.endMillis - span.startMillis;
    nodes.push({
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      depth,
      offsetPct: ((span.startMillis - runStart) / runDuration) * 100,
      widthPct: Math.max((durationMillis / runDuration) * 100, 0.5),
      durationMillis,
      startMillis: span.startMillis,
      endMillis: span.endMillis,
      attributes: span.attributes,
      status: span.status,
    });
    for (const child of childrenByParent.get(span.spanId) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of childrenByParent.get(undefined) ?? []) {
    visit(root, 0);
  }
  return nodes;
}
