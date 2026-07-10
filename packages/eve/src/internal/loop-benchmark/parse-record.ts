import {
  createAttemptId,
  createClockDomainId,
  createObservationId,
  createProcessInstanceId,
  createRecordId,
  createSampleId,
  type ClockDomainId,
  type EngineIds,
  type EventObservationRecord,
  type HostIdentity,
  type IntervalOutcome,
  type IntervalRecord,
  type MonotonicPoint,
  type ObservationRef,
  type RawRecord,
  type RecordBase,
  type SampleOutcome,
  type SerializedError,
} from "#internal/loop-benchmark/contract.js";
import { isPlainRecord } from "#shared/guards.js";

/** Parses one untrusted JSON string into the benchmark's typed record union. */
export function parseRawRecordJson(source: string): RawRecord {
  return parseRawRecord(JSON.parse(source) as unknown);
}

/** Validates one value at the raw-record ingestion boundary. */
export function parseRawRecord(value: unknown): RawRecord {
  const record = requireRecord(value, "Raw record");
  const base = parseRecordBase(record);

  switch (record.kind) {
    case "sample.opened":
      return {
        ...base,
        at: parsePoint(record.at, base.clockDomainId),
        kind: "sample.opened",
      };
    case "mark":
      return {
        ...base,
        at: parsePoint(record.at, base.clockDomainId),
        kind: "mark",
        name: readNonEmptyString(record.name, "Mark name"),
      };
    case "interval":
      return parseIntervalRecord(record, base);
    case "causal.edge":
      return {
        ...base,
        from: parseObservationRef(record.from),
        kind: "causal.edge",
        name: readNonEmptyString(record.name, "Causal edge name"),
        to: parseObservationRef(record.to),
      };
    case "engine.ids":
      return {
        ...base,
        at: parsePoint(record.at, base.clockDomainId),
        ids: parseEngineIds(record.ids),
        kind: "engine.ids",
      };
    case "event.observed":
      return parseEventObservationRecord(record, base);
    case "sample.closed":
      return {
        ...base,
        at: parsePoint(record.at, base.clockDomainId),
        kind: "sample.closed",
        outcome: parseSampleOutcome(record.outcome),
      };
    default:
      throw new TypeError(`Raw record has unsupported kind "${String(record.kind)}".`);
  }
}

function parseRecordBase(record: Record<string, unknown>): RecordBase {
  if (record.schemaVersion !== 1) {
    throw new TypeError(
      `Raw record has unsupported schema version "${String(record.schemaVersion)}".`,
    );
  }

  return {
    actor: readLiteral(record.actor, RECORD_ACTORS, "Record actor"),
    attemptId: createAttemptId(readNonEmptyString(record.attemptId, "AttemptId")),
    clockDomainId: createClockDomainId(readNonEmptyString(record.clockDomainId, "ClockDomainId")),
    host: parseHostIdentity(record.host),
    processInstanceId: createProcessInstanceId(
      readNonEmptyString(record.processInstanceId, "ProcessInstanceId"),
    ),
    recordId: createRecordId(readNonEmptyString(record.recordId, "RecordId")),
    runtime: readLiteral(record.runtime, RUNTIME_KINDS, "Runtime kind"),
    sampleId: createSampleId(readNonEmptyString(record.sampleId, "SampleId")),
    schemaVersion: 1,
  };
}

function parseHostIdentity(value: unknown): HostIdentity {
  const host = requireRecord(value, "Host identity");
  const base = {
    id: readNonEmptyString(host.id, "Host identity id"),
    role: readLiteral(host.role, HOST_ROLES, "Host role"),
    target: readLiteral(host.target, BENCHMARK_TARGETS, "Benchmark target"),
  };
  const region = readOptionalNonEmptyString(host.region, "Host region");
  return region === undefined ? base : { ...base, region };
}

function parsePoint(value: unknown, expectedClockDomainId: ClockDomainId): MonotonicPoint {
  const point = requireRecord(value, "Monotonic point");
  const clockDomainId = createClockDomainId(
    readNonEmptyString(point.clockDomainId, "ClockDomainId"),
  );
  if (clockDomainId !== expectedClockDomainId) {
    throw new TypeError("Monotonic point must use the record's clock domain.");
  }
  return {
    clockDomainId,
    id: createObservationId(readNonEmptyString(point.id, "ObservationId")),
    monotonicMs: readNonNegativeFiniteNumber(point.monotonicMs, "Monotonic time"),
  };
}

function parseObservationRef(value: unknown): ObservationRef {
  const ref = requireRecord(value, "Observation reference");
  return {
    clockDomainId: createClockDomainId(readNonEmptyString(ref.clockDomainId, "ClockDomainId")),
    observationId: createObservationId(readNonEmptyString(ref.observationId, "ObservationId")),
  };
}

function parseIntervalRecord(record: Record<string, unknown>, base: RecordBase): IntervalRecord {
  const start = parsePoint(record.start, base.clockDomainId);
  const end = parsePoint(record.end, base.clockDomainId);
  if (end.monotonicMs < start.monotonicMs) {
    throw new TypeError("Interval end cannot precede its start.");
  }

  const parentRecordId = readOptionalNonEmptyString(record.parentRecordId, "Parent RecordId");
  const parsed = {
    ...base,
    end,
    kind: "interval" as const,
    name: readNonEmptyString(record.name, "Interval name"),
    outcome: parseIntervalOutcome(record.outcome),
    role: readLiteral(record.role, INTERVAL_ROLES, "Interval role"),
    start,
  };
  return parentRecordId === undefined
    ? parsed
    : { ...parsed, parentRecordId: createRecordId(parentRecordId) };
}

function parseIntervalOutcome(value: unknown): IntervalOutcome {
  const outcome = requireRecord(value, "Interval outcome");
  switch (outcome.kind) {
    case "succeeded":
      return { kind: "succeeded" };
    case "failed":
      return { error: parseSerializedError(outcome.error), kind: "failed" };
    default:
      throw new TypeError(`Interval outcome has unsupported kind "${String(outcome.kind)}".`);
  }
}

function parseSampleOutcome(value: unknown): SampleOutcome {
  const outcome = requireRecord(value, "Sample outcome");
  switch (outcome.kind) {
    case "passed":
      return { kind: "passed" };
    case "invalid":
      return {
        kind: "invalid",
        reason: readNonEmptyString(outcome.reason, "Invalid sample reason"),
      };
    case "failed":
      return { error: parseSerializedError(outcome.error), kind: "failed" };
    default:
      throw new TypeError(`Sample outcome has unsupported kind "${String(outcome.kind)}".`);
  }
}

function parseSerializedError(value: unknown): SerializedError {
  const error = requireRecord(value, "Serialized error");
  return {
    message: readNonEmptyString(error.message, "Error message"),
    name: readNonEmptyString(error.name, "Error name"),
  };
}

function parseEngineIds(value: unknown): EngineIds {
  const ids = requireRecord(value, "Engine ids");
  switch (ids.kind) {
    case "inline.controller":
      return {
        controllerId: readNonEmptyString(ids.controllerId, "Inline controller id"),
        kind: "inline.controller",
      };
    case "workflow.run":
      return {
        kind: "workflow.run",
        workflowRunId: readNonEmptyString(ids.workflowRunId, "Workflow run id"),
      };
    case "workflow.step":
      return {
        attempt: readPositiveInteger(ids.attempt, "Workflow step attempt"),
        kind: "workflow.step",
        stepId: readNonEmptyString(ids.stepId, "Workflow step id"),
        workflowRunId: readNonEmptyString(ids.workflowRunId, "Workflow run id"),
      };
    case "temporal.workflow":
      return {
        kind: "temporal.workflow",
        runId: readNonEmptyString(ids.runId, "Temporal run id"),
        workflowId: readNonEmptyString(ids.workflowId, "Temporal workflow id"),
      };
    case "temporal.activity":
      return {
        activityId: readNonEmptyString(ids.activityId, "Temporal activity id"),
        attempt: readPositiveInteger(ids.attempt, "Temporal activity attempt"),
        kind: "temporal.activity",
        runId: readNonEmptyString(ids.runId, "Temporal run id"),
        workflowId: readNonEmptyString(ids.workflowId, "Temporal workflow id"),
      };
    default:
      throw new TypeError(`Engine ids have unsupported kind "${String(ids.kind)}".`);
  }
}

function parseEventObservationRecord(
  record: Record<string, unknown>,
  base: RecordBase,
): EventObservationRecord {
  const parsed = {
    ...base,
    at: parsePoint(record.at, base.clockDomainId),
    eventType: readNonEmptyString(record.eventType, "Event type"),
    kind: "event.observed" as const,
    ordinal: readNonNegativeInteger(record.ordinal, "Event ordinal"),
    stage: readLiteral(record.stage, EVENT_STAGES, "Event observation stage"),
  };
  const encodedBytes = readOptionalNonNegativeInteger(record.encodedBytes, "Encoded byte count");
  const metaAt = readOptionalNonEmptyString(record.metaAt, "Event meta.at");
  const withEncodedBytes = encodedBytes === undefined ? parsed : { ...parsed, encodedBytes };
  return metaAt === undefined ? withEncodedBytes : { ...withEncodedBytes, metaAt };
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

function readNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function readOptionalNonEmptyString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : readNonEmptyString(value, name);
}

function readNonNegativeFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function readOptionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : readNonNegativeInteger(value, name);
}

function readLiteral<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  name: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${name} has unsupported value "${String(value)}".`);
  }
  return value as Values[number];
}

const RUNTIME_KINDS = ["inline", "workflow", "temporal"] as const;
const BENCHMARK_TARGETS = ["local", "vercel"] as const;
const RECORD_ACTORS = [
  "client",
  "controller",
  "session",
  "turn",
  "worker",
  "stream",
  "collector",
  "store",
] as const;
const HOST_ROLES = ["client", "controller", "worker", "stream", "collector", "store"] as const;
const INTERVAL_ROLES = ["leaf", "envelope"] as const;
const EVENT_STAGES = ["publish.ack", "stream.enqueue", "client.receive", "client.reduce"] as const;
