import type { CapturedAttributeValue, CapturedSpan } from "#internal/tracing/captured-span.js";

/**
 * Minimal OTLP/JSON encoder and decoder for captured spans.
 *
 * The on-disk trace format is a standard OTLP `ExportTraceServiceRequest` so a
 * stored trace can be re-POSTed to any OTLP endpoint (`eve trace export`) and
 * ingested by any OTel-native tool. Only the span fields eve captures are
 * encoded; unknown attribute value shapes decode to `undefined` and are dropped.
 *
 * @see https://opentelemetry.io/docs/specs/otlp/#otlpjson
 */

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status?: { code?: number; message?: string };
}

interface OtlpScopeSpans {
  scope: { name: string };
  spans: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource: { attributes: OtlpKeyValue[] };
  scopeSpans: OtlpScopeSpans[];
}

/** A standard OTLP/JSON trace export payload. */
export interface OtlpTracePayload {
  resourceSpans: OtlpResourceSpans[];
}

const SCOPE_NAME = "eve";

function encodeAttributeValue(value: CapturedAttributeValue): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return {
    arrayValue: {
      values: value
        .filter(
          (entry): entry is string | number | boolean => entry !== null && entry !== undefined,
        )
        .map(encodeAttributeValue),
    },
  };
}

function decodeAttributeValue(value: OtlpAnyValue): CapturedAttributeValue | undefined {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue !== undefined) {
    return value.arrayValue.values
      .map(decodeAttributeValue)
      .filter((entry): entry is string | number | boolean => entry !== undefined);
  }
  return undefined;
}

function encodeAttributes(
  attributes: Readonly<Record<string, CapturedAttributeValue>>,
): OtlpKeyValue[] {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: encodeAttributeValue(value),
  }));
}

function decodeAttributes(
  attributes: readonly OtlpKeyValue[],
): Record<string, CapturedAttributeValue> {
  const result: Record<string, CapturedAttributeValue> = {};
  for (const entry of attributes) {
    const decoded = decodeAttributeValue(entry.value);
    if (decoded !== undefined) result[entry.key] = decoded;
  }
  return result;
}

/** Encodes captured spans as one OTLP/JSON `ExportTraceServiceRequest`. */
export function capturedSpansToOtlp(
  spans: readonly CapturedSpan[],
  resourceAttributes: Readonly<Record<string, CapturedAttributeValue>> = {},
): OtlpTracePayload {
  return {
    resourceSpans: [
      {
        resource: { attributes: encodeAttributes(resourceAttributes) },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME },
            spans: spans.map((span) => {
              const otlpSpan: OtlpSpan = {
                traceId: span.traceId,
                spanId: span.spanId,
                name: span.name,
                kind: span.kind,
                startTimeUnixNano: span.startTimeUnixNano,
                endTimeUnixNano: span.endTimeUnixNano,
                attributes: encodeAttributes(span.attributes),
              };
              if (span.parentSpanId !== undefined) otlpSpan.parentSpanId = span.parentSpanId;
              if (span.status !== undefined) otlpSpan.status = span.status;
              return otlpSpan;
            }),
          },
        ],
      },
    ],
  };
}

function unixNanoToMillis(unixNano: string): number {
  return Number(BigInt(unixNano)) / 1_000_000;
}

/** Decodes an OTLP/JSON payload back into captured spans. */
export function otlpToCapturedSpans(payload: OtlpTracePayload): CapturedSpan[] {
  const spans: CapturedSpan[] = [];
  for (const resourceSpans of payload.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        spans.push({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          kind: span.kind ?? 0,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          startMillis: unixNanoToMillis(span.startTimeUnixNano),
          endMillis: unixNanoToMillis(span.endTimeUnixNano),
          attributes: decodeAttributes(span.attributes ?? []),
          status:
            span.status?.code === undefined
              ? undefined
              : { code: span.status.code, message: span.status.message },
        });
      }
    }
  }
  return spans;
}
