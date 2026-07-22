import type { ReadableSpan } from "#compiled/@opentelemetry/sdk-trace-base/index.js";

/**
 * A single attribute value carried on a captured span. Mirrors the subset of
 * OpenTelemetry attribute values eve spans actually use.
 */
export type CapturedAttributeValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean | null | undefined>;

/**
 * A finished span, normalized into a plain, JSON-serializable shape.
 *
 * This is eve's own in-memory and wire representation (ring buffer, viewer data
 * endpoint). Timestamps are kept as Unix-nanosecond strings so no precision is
 * lost on the round-trip through {@link https://opentelemetry.io/docs/specs/otlp/ OTLP/JSON},
 * which is the on-disk format; `startMillis`/`endMillis` are derived conveniences
 * for rendering.
 */
export interface CapturedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly startMillis: number;
  readonly endMillis: number;
  readonly attributes: Readonly<Record<string, CapturedAttributeValue>>;
  readonly status?: { readonly code: number; readonly message?: string };
}

/** Controls whether prompt/response payloads are retained on captured spans. */
export interface PayloadCaptureOptions {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

// AI SDK / GenAI attribute keys that carry model inputs (prompts, tool args)
// or outputs (completions, tool results). Matched case-insensitively as
// substrings so provider-specific variants are covered without an exhaustive
// list.
const INPUT_ATTRIBUTE_MARKERS = ["prompt", "messages", ".args", ".input", "arguments"];
const OUTPUT_ATTRIBUTE_MARKERS = ["response", "completion", ".output", ".result", ".text"];

// Structural telemetry (token usage, model ids, finish reasons, counts, and all
// framework `eve.*` attributes) is never a "payload" — redaction targets only
// large or sensitive message bodies, so these are always retained.
const STRUCTURAL_MARKERS = ["eve.", "usage", "token", "model", "finish", "count"];

function isStructuralAttribute(key: string): boolean {
  const lower = key.toLowerCase();
  return STRUCTURAL_MARKERS.some((marker) => lower.includes(marker));
}

function isPayloadAttribute(key: string, markers: readonly string[]): boolean {
  if (isStructuralAttribute(key)) return false;
  const lower = key.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

/**
 * Drops input and/or output payload attributes according to
 * {@link PayloadCaptureOptions}. Structural `eve.*`/`gen_ai.usage.*` attributes
 * and timings are always retained — only the potentially large or sensitive
 * message bodies are redacted.
 */
export function redactPayloadAttributes(
  attributes: Readonly<Record<string, CapturedAttributeValue>>,
  options: PayloadCaptureOptions,
): Record<string, CapturedAttributeValue> {
  const result: Record<string, CapturedAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!options.recordInputs && isPayloadAttribute(key, INPUT_ATTRIBUTE_MARKERS)) continue;
    if (!options.recordOutputs && isPayloadAttribute(key, OUTPUT_ATTRIBUTE_MARKERS)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Reads a framework `eve.*` context value from a captured span.
 *
 * eve stamps these in two shapes: the turn span (`ai.eve.turn`) carries the
 * bare `eve.<key>`, while the AI SDK model/tool spans carry the same value
 * under `ai.settings.context.eve.<key>` (the AI SDK's runtime-context prefix).
 * Callers pass the short key (e.g. `"session.id"`) and get whichever is set.
 */
export function readEveAttribute(
  attributes: Readonly<Record<string, CapturedAttributeValue>>,
  key: string,
): string | undefined {
  const direct = attributes[`eve.${key}`];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const prefixed = attributes[`ai.settings.context.eve.${key}`];
  if (typeof prefixed === "string" && prefixed.length > 0) return prefixed;
  return undefined;
}

const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_MILLI = 1_000_000;

/** Converts an OpenTelemetry `HrTime` (`[seconds, nanos]`) to a Unix-nano string. */
export function hrTimeToUnixNano(hrTime: readonly [number, number]): string {
  return (BigInt(hrTime[0]) * NANOS_PER_SECOND + BigInt(hrTime[1])).toString();
}

/** Converts a Unix-nanosecond string to fractional milliseconds. */
export function unixNanoToMillis(unixNano: string): number {
  return Number(BigInt(unixNano)) / NANOS_PER_MILLI;
}

function normalizeAttributes(
  attributes: Readonly<Record<string, unknown>>,
): Record<string, CapturedAttributeValue> {
  const result: Record<string, CapturedAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    result[key] = value as CapturedAttributeValue;
  }
  return result;
}

/**
 * Normalizes an OpenTelemetry {@link ReadableSpan} into a {@link CapturedSpan},
 * applying payload redaction. The span's own context and parent context supply
 * the trace/span/parent ids used to reassemble the waterfall.
 */
export function capturedSpanFromReadable(
  span: ReadableSpan,
  options: PayloadCaptureOptions,
): CapturedSpan {
  const startTimeUnixNano = hrTimeToUnixNano(span.startTime);
  const endTimeUnixNano = hrTimeToUnixNano(span.endTime);
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano,
    endTimeUnixNano,
    startMillis: unixNanoToMillis(startTimeUnixNano),
    endMillis: unixNanoToMillis(endTimeUnixNano),
    attributes: redactPayloadAttributes(normalizeAttributes(span.attributes), options),
    status: span.status,
  };
}
