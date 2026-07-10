import { describe, expect, it } from "vitest";

import {
  createAttemptId,
  createClockDomainId,
  createProcessInstanceId,
  createSampleId,
  type ClockDomainId,
  type RawRecord,
} from "#internal/loop-benchmark/contract.js";
import {
  InMemoryRawRecordWriter,
  LoopBenchmarkRecorder,
  type MonotonicClock,
} from "#internal/loop-benchmark/recorder.js";

class FakeClock implements MonotonicClock {
  readonly #values: number[];

  constructor(values: readonly number[]) {
    this.#values = [...values];
  }

  now(): number {
    const value = this.#values.shift();
    if (value === undefined) throw new Error("Fake clock exhausted.");
    return value;
  }
}

function createRecorder(input: {
  readonly clockDomainId?: ClockDomainId;
  readonly clockValues: readonly number[];
  readonly process: string;
}) {
  const writer = new InMemoryRawRecordWriter();
  const recorder = new LoopBenchmarkRecorder({
    clock: new FakeClock(input.clockValues),
    scope: {
      actor: "worker",
      attemptId: createAttemptId(`attempt:${input.process}`),
      clockDomainId: input.clockDomainId ?? createClockDomainId(`clock:${input.process}`),
      host: {
        id: `host:${input.process}`,
        role: "worker",
        target: "local",
      },
      processInstanceId: createProcessInstanceId(input.process),
      runtime: "workflow",
      sampleId: createSampleId("sample-1"),
    },
    writer,
  });
  return { recorder, writer };
}

function onlyRecord(records: readonly RawRecord[]): RawRecord {
  expect(records).toHaveLength(1);
  const record = records[0];
  if (record === undefined) throw new Error("Expected one record.");
  return record;
}

describe("LoopBenchmarkRecorder", () => {
  it("records a successful half-open interval with an injected clock", async () => {
    const { recorder, writer } = createRecorder({
      clockValues: [10, 14],
      process: "process-a",
    });

    await expect(
      recorder.interval({ name: "step.hydrate", role: "leaf" }, async () => "ready"),
    ).resolves.toBe("ready");

    expect(onlyRecord(writer.records)).toMatchObject({
      kind: "interval",
      name: "step.hydrate",
      outcome: { kind: "succeeded" },
      role: "leaf",
      start: { monotonicMs: 10 },
      end: { monotonicMs: 14 },
    });
  });

  it("records a failed interval and rethrows the same value", async () => {
    const { recorder, writer } = createRecorder({
      clockValues: [20, 23],
      process: "process-a",
    });
    const failure = new Error("model failed");

    let caught: unknown;
    try {
      await recorder.interval({ name: "model.provider", role: "leaf" }, async () => {
        throw failure;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(onlyRecord(writer.records)).toMatchObject({
      kind: "interval",
      name: "model.provider",
      outcome: {
        error: { message: "model failed", name: "Error" },
        kind: "failed",
      },
      start: { monotonicMs: 20 },
      end: { monotonicMs: 23 },
    });
  });

  it("records causal order across clock domains without a duration", () => {
    const first = createRecorder({ clockValues: [5], process: "process-a" });
    const second = createRecorder({ clockValues: [900], process: "process-b" });
    const returned = first.recorder.mark("step.result.returned");
    const accepted = second.recorder.mark("step.result.accepted");

    first.recorder.edge("step.result.returned_to_accepted", returned, accepted);

    const edge = first.writer.records.at(-1);
    expect(edge).toMatchObject({
      from: {
        clockDomainId: createClockDomainId("clock:process-a"),
        observationId: returned.id,
      },
      kind: "causal.edge",
      to: {
        clockDomainId: createClockDomainId("clock:process-b"),
        observationId: accepted.id,
      },
    });
    expect(edge).not.toHaveProperty("durationMs");
    expect(edge).not.toHaveProperty("start");
    expect(edge).not.toHaveProperty("end");
  });
});
