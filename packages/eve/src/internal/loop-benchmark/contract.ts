declare const brand: unique symbol;

type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type SampleId = Brand<string, "SampleId">;
export type AttemptId = Brand<string, "AttemptId">;
export type RecordId = Brand<string, "RecordId">;
export type ObservationId = Brand<string, "ObservationId">;
export type ClockDomainId = Brand<string, "ClockDomainId">;
export type ProcessInstanceId = Brand<string, "ProcessInstanceId">;

export type RuntimeKind = "inline" | "workflow" | "temporal";
export type BenchmarkTarget = "local" | "vercel";
export type RecordActor =
  | "client"
  | "controller"
  | "session"
  | "turn"
  | "worker"
  | "stream"
  | "collector"
  | "store";
export type HostRole = "client" | "controller" | "worker" | "stream" | "collector" | "store";

export interface HostIdentity {
  readonly id: string;
  readonly region?: string;
  readonly role: HostRole;
  readonly target: BenchmarkTarget;
}

export interface RecordBase {
  readonly actor: RecordActor;
  readonly attemptId: AttemptId;
  readonly clockDomainId: ClockDomainId;
  readonly host: HostIdentity;
  readonly processInstanceId: ProcessInstanceId;
  readonly recordId: RecordId;
  readonly runtime: RuntimeKind;
  readonly sampleId: SampleId;
  readonly schemaVersion: 1;
}

/** One observation on the record's local monotonic clock. */
export interface MonotonicPoint {
  readonly clockDomainId: ClockDomainId;
  readonly id: ObservationId;
  readonly monotonicMs: number;
}

/** A point reference carries identity and clock domain, but never a comparable timestamp. */
export interface ObservationRef {
  readonly clockDomainId: ClockDomainId;
  readonly observationId: ObservationId;
}

export interface SerializedError {
  readonly message: string;
  readonly name: string;
}

export type IntervalOutcome =
  | { readonly kind: "succeeded" }
  | { readonly error: SerializedError; readonly kind: "failed" };

export type SampleOutcome =
  | { readonly kind: "passed" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly error: SerializedError; readonly kind: "failed" };

export type EngineIds =
  | { readonly controllerId: string; readonly kind: "inline.controller" }
  | { readonly kind: "workflow.run"; readonly workflowRunId: string }
  | {
      readonly attempt: number;
      readonly kind: "workflow.step";
      readonly stepId: string;
      readonly workflowRunId: string;
    }
  | {
      readonly kind: "temporal.workflow";
      readonly runId: string;
      readonly workflowId: string;
    }
  | {
      readonly activityId: string;
      readonly attempt: number;
      readonly kind: "temporal.activity";
      readonly runId: string;
      readonly workflowId: string;
    };

export interface SampleOpenedRecord extends RecordBase {
  readonly at: MonotonicPoint;
  readonly kind: "sample.opened";
}

export interface MarkRecord extends RecordBase {
  readonly at: MonotonicPoint;
  readonly kind: "mark";
  readonly name: string;
}

/** A local half-open interval `[start, end)` within exactly one clock domain. */
export interface IntervalRecord extends RecordBase {
  readonly end: MonotonicPoint;
  readonly kind: "interval";
  readonly name: string;
  readonly outcome: IntervalOutcome;
  readonly parentRecordId?: RecordId;
  readonly role: "leaf" | "envelope";
  readonly start: MonotonicPoint;
}

/** Cross-clock ordering only. Deliberately contains no timestamps or duration. */
export interface CausalEdgeRecord extends RecordBase {
  readonly from: ObservationRef;
  readonly kind: "causal.edge";
  readonly name: string;
  readonly to: ObservationRef;
}

export interface EngineIdsRecord extends RecordBase {
  readonly at: MonotonicPoint;
  readonly ids: EngineIds;
  readonly kind: "engine.ids";
}

export type EventObservationStage =
  | "publish.ack"
  | "stream.enqueue"
  | "client.receive"
  | "client.reduce";

export interface EventObservationRecord extends RecordBase {
  readonly at: MonotonicPoint;
  readonly encodedBytes?: number;
  readonly eventType: string;
  readonly kind: "event.observed";
  readonly metaAt?: string;
  readonly ordinal: number;
  readonly stage: EventObservationStage;
}

export interface SampleClosedRecord extends RecordBase {
  readonly at: MonotonicPoint;
  readonly kind: "sample.closed";
  readonly outcome: SampleOutcome;
}

export type RawRecord =
  | SampleOpenedRecord
  | MarkRecord
  | IntervalRecord
  | CausalEdgeRecord
  | EngineIdsRecord
  | EventObservationRecord
  | SampleClosedRecord;

export function createSampleId(value: string): SampleId {
  return createIdentifier(value, "SampleId");
}

export function createAttemptId(value: string): AttemptId {
  return createIdentifier(value, "AttemptId");
}

export function createRecordId(value: string): RecordId {
  return createIdentifier(value, "RecordId");
}

export function createObservationId(value: string): ObservationId {
  return createIdentifier(value, "ObservationId");
}

export function createClockDomainId(value: string): ClockDomainId {
  return createIdentifier(value, "ClockDomainId");
}

export function createProcessInstanceId(value: string): ProcessInstanceId {
  return createIdentifier(value, "ProcessInstanceId");
}

function createIdentifier<Name extends string>(value: string, name: Name): Brand<string, Name> {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value as Brand<string, Name>;
}
