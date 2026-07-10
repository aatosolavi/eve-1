import { describe, expect, it } from "vitest";

import {
  createAttemptId,
  createClockDomainId,
  createObservationId,
  createProcessInstanceId,
  createRecordId,
  createSampleId,
  type RawRecord,
  type RecordBase,
} from "#internal/loop-benchmark/contract.js";
import { parseRawRecordJson } from "#internal/loop-benchmark/parse-record.js";

const clockDomainId = createClockDomainId("host-a:process-a");

const base: RecordBase = {
  actor: "worker",
  attemptId: createAttemptId("attempt-1"),
  clockDomainId,
  host: {
    id: "host-a",
    role: "worker",
    target: "local",
  },
  processInstanceId: createProcessInstanceId("process-a"),
  recordId: createRecordId("record-base"),
  runtime: "workflow",
  sampleId: createSampleId("sample-1"),
  schemaVersion: 1,
};

function point(id: string, monotonicMs: number) {
  return {
    clockDomainId,
    id: createObservationId(id),
    monotonicMs,
  };
}

describe("raw benchmark record parsing", () => {
  it("round-trips every record variant through JSON", () => {
    const records = [
      {
        ...base,
        at: point("sample-opened", 1),
        kind: "sample.opened",
      },
      {
        ...base,
        at: point("mark", 2),
        kind: "mark",
        name: "step.result.returned",
      },
      {
        ...base,
        end: point("interval-end", 5),
        kind: "interval",
        name: "step.hydrate",
        outcome: { kind: "succeeded" },
        role: "leaf",
        start: point("interval-start", 3),
      },
      {
        ...base,
        from: {
          clockDomainId,
          observationId: createObservationId("interval-end"),
        },
        kind: "causal.edge",
        name: "step.result.returned_to_accepted",
        to: {
          clockDomainId: createClockDomainId("host-b:process-b"),
          observationId: createObservationId("step-accepted"),
        },
      },
      {
        ...base,
        at: point("engine", 6),
        ids: {
          attempt: 2,
          kind: "workflow.step",
          stepId: "step-1",
          workflowRunId: "run-1",
        },
        kind: "engine.ids",
      },
      {
        ...base,
        at: point("event", 7),
        encodedBytes: 81,
        eventType: "session.waiting",
        kind: "event.observed",
        metaAt: "2026-07-10T10:00:00.000Z",
        ordinal: 4,
        stage: "client.receive",
      },
      {
        ...base,
        at: point("sample-closed", 8),
        kind: "sample.closed",
        outcome: { kind: "invalid", reason: "unexpected retry" },
      },
    ] satisfies readonly RawRecord[];

    for (const record of records) {
      expect(parseRawRecordJson(JSON.stringify(record))).toEqual(record);
    }
  });

  it("rejects an interval whose end precedes its start", () => {
    const record = {
      ...base,
      end: point("end", 9),
      kind: "interval",
      name: "model.provider",
      outcome: { kind: "succeeded" },
      role: "leaf",
      start: point("start", 10),
    };

    expect(() => parseRawRecordJson(JSON.stringify(record))).toThrow(
      "Interval end cannot precede its start.",
    );
  });

  it("rejects empty branded identifiers", () => {
    expect(() => createSampleId("  ")).toThrow("SampleId must be a non-empty string.");
  });
});
