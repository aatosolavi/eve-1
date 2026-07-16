import type { WireValue } from "./types.js";

export interface WireEnvelopeV1 {
  readonly codec: "eve-json";
  readonly value: WireValue;
  readonly version: 1;
}

export function encodeWireEnvelope(value: WireValue): WireEnvelopeV1 {
  return { codec: "eve-json", value, version: 1 };
}

export function decodeWireEnvelope(value: unknown): WireValue {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Wire envelope must be an object.");
  }

  const envelope = value as Record<string, unknown>;
  if (envelope.codec !== "eve-json") {
    throw new TypeError("Wire envelope has an unsupported codec.");
  }
  if (envelope.version !== 1) {
    throw new TypeError(`Wire envelope has unsupported version "${String(envelope.version)}".`);
  }
  return parseWireValue(envelope.value);
}

export function parseWireValue(value: unknown): WireValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) return value.map(parseWireValue);

  if (typeof value !== "object") {
    throw new TypeError(`Unsupported wire value type "${typeof value}".`);
  }

  const parsed: Record<string, WireValue> = {};
  for (const [key, entry] of Object.entries(value)) parsed[key] = parseWireValue(entry);
  return parsed;
}

export function parseJsonWireValue(value: string): WireValue {
  return parseWireValue(JSON.parse(value) as unknown);
}

export function stringifyWireValue(value: WireValue): string {
  return JSON.stringify(value);
}

export function stringifyCanonical(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): WireValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return parseWireValue(value);

  const sorted: Record<string, WireValue> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
