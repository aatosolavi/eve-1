import { setTimeout as defaultSleep } from "node:timers/promises";

import type { BenchmarkRuntimeKind } from "../driver/index.js";

const PARK_ACCEPTED_MARK = "runtime.park.accepted";
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_QUIET_PERIOD_MS = 100;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface RawServerTelemetryRecord {
  readonly [key: string]: unknown;
  readonly kind: ServerTelemetryRecordKind;
  readonly runtime: BenchmarkRuntimeKind;
  readonly sampleId: string;
}

export interface ServerTelemetryResultBase {
  readonly rawRecords: readonly RawServerTelemetryRecord[];
  readonly summedIntervalDurationsMsByName: Readonly<Record<string, number>>;
}

export type ServerTelemetryResult =
  | (ServerTelemetryResultBase & { readonly status: "complete" })
  | (ServerTelemetryResultBase & { readonly status: "incomplete" })
  | (ServerTelemetryResultBase & { readonly status: "unavailable" })
  | (ServerTelemetryResultBase & {
      readonly error: { readonly message: string; readonly name: string };
      readonly status: "failed";
    });

export interface ReadServerTelemetryInput {
  readonly expectedRuntime: BenchmarkRuntimeKind;
  readonly expectedSampleId: string;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly quietPeriodMs?: number;
  readonly readText: () => Promise<string | undefined>;
  readonly sleep?: (durationMs: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly waitForPark: boolean;
}

export async function readServerTelemetry(
  input: ReadServerTelemetryInput,
): Promise<ServerTelemetryResult> {
  const now = input.now ?? performance.now.bind(performance);
  const sleep = input.sleep ?? defaultSleep;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const quietPeriodMs = input.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = now();
  let hasPreviousRead = false;
  let observedText = false;
  let quietSince: number | undefined;
  let previousText: string | undefined;
  let rawRecords: readonly RawServerTelemetryRecord[] = [];

  for (;;) {
    let text: string | undefined;
    try {
      text = await input.readText();
      if (text !== undefined) {
        observedText = true;
        rawRecords = parseJsonl(text).filter(
          (record) =>
            record.sampleId === input.expectedSampleId && record.runtime === input.expectedRuntime,
        );
      }
    } catch (error) {
      return failedResult(rawRecords, error);
    }

    const hasMatchingRecords = rawRecords.length > 0;
    const parkAccepted = rawRecords.some(
      (record) => record.kind === "mark" && record.name === PARK_ACCEPTED_MARK,
    );
    if (hasMatchingRecords && input.waitForPark && parkAccepted) {
      return result("complete", rawRecords);
    }

    const observedAt = now();
    if (!input.waitForPark) {
      if (!hasPreviousRead || text !== previousText) {
        hasPreviousRead = true;
        previousText = text;
        quietSince = observedAt;
      } else if (quietSince !== undefined && observedAt - quietSince >= quietPeriodMs) {
        return result(
          hasMatchingRecords ? "complete" : observedText ? "incomplete" : "unavailable",
          rawRecords,
        );
      }
    }

    if (observedAt - startedAt >= timeoutMs) {
      return result(observedText ? "incomplete" : "unavailable", rawRecords);
    }

    try {
      await sleep(pollIntervalMs);
    } catch (error) {
      return failedResult(rawRecords, error);
    }
  }
}

function parseJsonl(text: string): readonly RawServerTelemetryRecord[] {
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();

  return lines.flatMap((line, index) => {
    const source = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (source.trim().length === 0) return [];

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new TypeError(`Server telemetry line ${index + 1} is not valid JSON.`, {
        cause: error,
      });
    }
    if (!isRawServerTelemetryRecord(value)) {
      throw new TypeError(`Server telemetry line ${index + 1} is not a valid telemetry record.`);
    }
    return [value];
  });
}

function isRawServerTelemetryRecord(value: unknown): value is RawServerTelemetryRecord {
  if (!isRecord(value)) return false;
  if (
    typeof value.sampleId !== "string" ||
    value.sampleId.trim().length === 0 ||
    !isRuntime(value.runtime) ||
    !isRecordKind(value.kind)
  ) {
    return false;
  }
  if (value.kind === "mark") {
    return typeof value.name === "string" && value.name.trim().length > 0;
  }
  if (value.kind === "interval") {
    return typeof value.name === "string" && value.name.trim().length > 0;
  }
  return true;
}

function result(
  status: "complete" | "incomplete" | "unavailable",
  rawRecords: readonly RawServerTelemetryRecord[],
): ServerTelemetryResult {
  return {
    rawRecords,
    status,
    summedIntervalDurationsMsByName: sumIntervalDurations(rawRecords),
  };
}

function failedResult(
  rawRecords: readonly RawServerTelemetryRecord[],
  error: unknown,
): ServerTelemetryResult {
  return {
    error: serializeError(error),
    rawRecords,
    status: "failed",
    summedIntervalDurationsMsByName: sumIntervalDurations(rawRecords),
  };
}

function sumIntervalDurations(
  records: readonly RawServerTelemetryRecord[],
): Readonly<Record<string, number>> {
  const totals = new Map<string, number>();
  for (const record of records) {
    const interval = readValidInterval(record);
    if (interval === undefined) continue;

    const previous = totals.get(interval.name) ?? 0;
    const next = previous + interval.durationMs;
    if (Number.isFinite(next)) totals.set(interval.name, next);
  }
  return Object.fromEntries([...totals].toSorted(([left], [right]) => left.localeCompare(right)));
}

function readValidInterval(
  record: RawServerTelemetryRecord,
): { readonly durationMs: number; readonly name: string } | undefined {
  if (record.kind !== "interval" || typeof record.name !== "string") return undefined;
  if (!isRecord(record.start) || !isRecord(record.end)) return undefined;

  const startClock = record.start.clockDomainId;
  const endClock = record.end.clockDomainId;
  const start = record.start.monotonicMs;
  const end = record.end.monotonicMs;
  if (
    typeof startClock !== "string" ||
    startClock !== endClock ||
    typeof start !== "number" ||
    !Number.isFinite(start) ||
    typeof end !== "number" ||
    !Number.isFinite(end) ||
    end < start
  ) {
    return undefined;
  }

  const durationMs = end - start;
  return Number.isFinite(durationMs) ? { durationMs, name: record.name } : undefined;
}

function isRuntime(value: unknown): value is BenchmarkRuntimeKind {
  return value === "inline" || value === "workflow" || value === "temporal";
}

type ServerTelemetryRecordKind =
  | "causal.edge"
  | "engine.ids"
  | "event.observed"
  | "interval"
  | "mark"
  | "sample.closed"
  | "sample.opened";

function isRecordKind(value: unknown): value is ServerTelemetryRecordKind {
  return (
    value === "causal.edge" ||
    value === "engine.ids" ||
    value === "event.observed" ||
    value === "interval" ||
    value === "mark" ||
    value === "sample.closed" ||
    value === "sample.opened"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeError(error: unknown): { readonly message: string; readonly name: string } {
  return error instanceof Error
    ? { message: error.message, name: error.name }
    : { message: String(error), name: "NonErrorThrown" };
}
