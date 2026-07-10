import {
  createObservationId,
  createRecordId,
  type CausalEdgeRecord,
  type EngineIds,
  type EngineIdsRecord,
  type EventObservationRecord,
  type EventObservationStage,
  type HostIdentity,
  type IntervalOutcome,
  type IntervalRecord,
  type MarkRecord,
  type MonotonicPoint,
  type RawRecord,
  type RecordActor,
  type RecordBase,
  type RuntimeKind,
  type SampleClosedRecord,
  type SampleId,
  type SampleOpenedRecord,
  type SampleOutcome,
  type SerializedError,
  type AttemptId,
  type ClockDomainId,
  type ProcessInstanceId,
} from "#internal/loop-benchmark/contract.js";

export interface MonotonicClock {
  now(): number;
}

/** Synchronous hot-path writes plus an explicitly asynchronous batch flush. */
export interface RawRecordWriter {
  write(record: RawRecord): void;
  flush(): Promise<void>;
}

export class InMemoryRawRecordWriter implements RawRecordWriter {
  readonly #records: RawRecord[] = [];

  get records(): readonly RawRecord[] {
    return this.#records;
  }

  write(record: RawRecord): void {
    this.#records.push(record);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

export interface RecorderScope {
  readonly actor: RecordActor;
  readonly attemptId: AttemptId;
  readonly clockDomainId: ClockDomainId;
  readonly host: HostIdentity;
  readonly processInstanceId: ProcessInstanceId;
  readonly runtime: RuntimeKind;
  readonly sampleId: SampleId;
}

export interface EventObservationInput {
  readonly encodedBytes?: number;
  readonly eventType: string;
  readonly metaAt?: string;
  readonly ordinal: number;
  readonly stage: EventObservationStage;
}

let nextRecorderInstance = 0;

export class LoopBenchmarkRecorder {
  readonly #clock: MonotonicClock;
  readonly #instanceOrdinal: number;
  readonly #scope: RecorderScope;
  readonly #writer: RawRecordWriter;
  #nextObservation = 0;
  #nextRecord = 0;

  constructor(input: {
    readonly clock: MonotonicClock;
    readonly scope: RecorderScope;
    readonly writer: RawRecordWriter;
  }) {
    this.#clock = input.clock;
    this.#instanceOrdinal = nextRecorderInstance++;
    this.#scope = input.scope;
    this.#writer = input.writer;
  }

  sampleOpened(): MonotonicPoint {
    const at = this.#point();
    const record: SampleOpenedRecord = {
      ...this.#base(),
      at,
      kind: "sample.opened",
    };
    this.#writer.write(record);
    return at;
  }

  sampleClosed(outcome: SampleOutcome): MonotonicPoint {
    const at = this.#point();
    const record: SampleClosedRecord = {
      ...this.#base(),
      at,
      kind: "sample.closed",
      outcome,
    };
    this.#writer.write(record);
    return at;
  }

  mark(name: string): MonotonicPoint {
    requireName(name, "Mark name");
    const at = this.#point();
    const record: MarkRecord = {
      ...this.#base(),
      at,
      kind: "mark",
      name,
    };
    this.#writer.write(record);
    return at;
  }

  async interval<T>(
    input: {
      readonly name: string;
      readonly parentRecordId?: IntervalRecord["parentRecordId"];
      readonly role: IntervalRecord["role"];
    },
    run: () => Promise<T>,
  ): Promise<T> {
    requireName(input.name, "Interval name");
    const start = this.#point();

    let result: T;
    try {
      result = await run();
    } catch (error) {
      try {
        this.#writeInterval(input, start, {
          error: serializeError(error),
          kind: "failed",
        });
      } catch {
        // The measured operation's failure remains authoritative.
      }
      throw error;
    }

    this.#writeInterval(input, start, { kind: "succeeded" });
    return result;
  }

  edge(name: string, from: MonotonicPoint, to: MonotonicPoint): void {
    requireName(name, "Causal edge name");
    const record: CausalEdgeRecord = {
      ...this.#base(),
      from: {
        clockDomainId: from.clockDomainId,
        observationId: from.id,
      },
      kind: "causal.edge",
      name,
      to: {
        clockDomainId: to.clockDomainId,
        observationId: to.id,
      },
    };
    this.#writer.write(record);
  }

  engine(ids: EngineIds): MonotonicPoint {
    const at = this.#point();
    const record: EngineIdsRecord = {
      ...this.#base(),
      at,
      ids,
      kind: "engine.ids",
    };
    this.#writer.write(record);
    return at;
  }

  observeEvent(input: EventObservationInput): MonotonicPoint {
    requireName(input.eventType, "Event type");
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
      throw new TypeError("Event ordinal must be a non-negative integer.");
    }
    if (
      input.encodedBytes !== undefined &&
      (!Number.isSafeInteger(input.encodedBytes) || input.encodedBytes < 0)
    ) {
      throw new TypeError("Encoded byte count must be a non-negative integer.");
    }
    if (input.metaAt !== undefined) requireName(input.metaAt, "Event meta.at");

    const at = this.#point();
    const requiredRecord = {
      ...this.#base(),
      at,
      eventType: input.eventType,
      kind: "event.observed" as const,
      ordinal: input.ordinal,
      stage: input.stage,
    };
    const withEncodedBytes =
      input.encodedBytes === undefined
        ? requiredRecord
        : { ...requiredRecord, encodedBytes: input.encodedBytes };
    const record: EventObservationRecord =
      input.metaAt === undefined ? withEncodedBytes : { ...withEncodedBytes, metaAt: input.metaAt };
    this.#writer.write(record);
    return at;
  }

  flush(): Promise<void> {
    return this.#writer.flush();
  }

  #writeInterval(
    input: {
      readonly name: string;
      readonly parentRecordId?: IntervalRecord["parentRecordId"];
      readonly role: IntervalRecord["role"];
    },
    start: MonotonicPoint,
    outcome: IntervalOutcome,
  ): void {
    const end = this.#point();
    if (end.monotonicMs < start.monotonicMs) {
      throw new TypeError("Monotonic clock moved backwards while recording an interval.");
    }
    const base = {
      ...this.#base(),
      end,
      kind: "interval" as const,
      name: input.name,
      outcome,
      role: input.role,
      start,
    };
    const record: IntervalRecord =
      input.parentRecordId === undefined ? base : { ...base, parentRecordId: input.parentRecordId };
    this.#writer.write(record);
  }

  #base(): RecordBase {
    return {
      ...this.#scope,
      recordId: createRecordId(
        `${this.#scope.processInstanceId}:${String(this.#instanceOrdinal)}:record:${String(this.#nextRecord++)}`,
      ),
      schemaVersion: 1,
    };
  }

  #point(): MonotonicPoint {
    const monotonicMs = this.#clock.now();
    if (!Number.isFinite(monotonicMs) || monotonicMs < 0) {
      throw new TypeError("Monotonic clock must return a non-negative finite number.");
    }
    return {
      clockDomainId: this.#scope.clockDomainId,
      id: createObservationId(
        `${this.#scope.processInstanceId}:${String(this.#instanceOrdinal)}:observation:${String(this.#nextObservation++)}`,
      ),
      monotonicMs,
    };
  }
}

function serializeError(error: unknown): SerializedError {
  return error instanceof Error
    ? { message: error.message || error.name, name: error.name || "Error" }
    : { message: String(error), name: "Error" };
}

function requireName(value: string, name: string): void {
  if (value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string.`);
}
