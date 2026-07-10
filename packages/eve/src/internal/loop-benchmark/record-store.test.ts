import { describe, expect, it } from "vitest";

import {
  createAttemptId,
  createClockDomainId,
  createObservationId,
  createProcessInstanceId,
  createRecordId,
  createSampleId,
  type RawRecord,
  type SampleId,
} from "#internal/loop-benchmark/contract.js";
import {
  MemoryLoopBenchmarkRecordStore,
  type LoopBenchmarkRecordStore,
  SqliteLoopBenchmarkRecordStore,
} from "#internal/loop-benchmark/record-store.js";

interface StoreFixture {
  readonly close: () => void;
  readonly store: LoopBenchmarkRecordStore;
}

const storeFactories = [
  {
    create: (): StoreFixture => ({
      close: () => undefined,
      store: new MemoryLoopBenchmarkRecordStore(),
    }),
    name: "memory",
  },
  {
    create: (): StoreFixture => {
      const store = new SqliteLoopBenchmarkRecordStore(":memory:");
      return { close: () => store.close(), store };
    },
    name: "SQLite",
  },
] as const;

for (const { create, name } of storeFactories) {
  describe(`${name} loop benchmark record store`, () => {
    it("appends and reads records in insertion order", async () => {
      const { close, store } = create();
      const sampleId = createSampleId("sample-1");
      const second = markRecord({ monotonicMs: 2, name: "second", recordId: "record-z", sampleId });
      const first = markRecord({ monotonicMs: 1, name: "first", recordId: "record-a", sampleId });

      try {
        await store.append([second, first]);

        await expect(store.read(sampleId)).resolves.toEqual([second, first]);
      } finally {
        close();
      }
    });

    it("isolates samples", async () => {
      const { close, store } = create();
      const sampleA = createSampleId("sample-a");
      const sampleB = createSampleId("sample-b");
      const firstA = markRecord({ recordId: "record-a-1", sampleId: sampleA });
      const onlyB = markRecord({ recordId: "record-b-1", sampleId: sampleB });
      const secondA = markRecord({ recordId: "record-a-2", sampleId: sampleA });

      try {
        await store.append([firstA, onlyB, secondA]);

        await expect(store.read(sampleA)).resolves.toEqual([firstA, secondA]);
        await expect(store.read(sampleB)).resolves.toEqual([onlyB]);
      } finally {
        close();
      }
    });

    it("treats an identical retry as a no-op", async () => {
      const { close, store } = create();
      const sampleId = createSampleId("sample-1");
      const record = markRecord({ recordId: "record-1", sampleId });

      try {
        await store.append([record]);
        await store.append([record]);

        await expect(store.read(sampleId)).resolves.toEqual([record]);
      } finally {
        close();
      }
    });

    it("rejects a retry that changes JSON under the same record ID", async () => {
      const { close, store } = create();
      const sampleId = createSampleId("sample-1");
      const record = markRecord({ name: "original", recordId: "record-1", sampleId });
      const conflicting = { ...record, name: "changed" };

      try {
        await store.append([record]);

        await expect(store.append([conflicting])).rejects.toThrow(
          'Record "record-1" was retried with different JSON.',
        );
        await expect(store.read(sampleId)).resolves.toEqual([record]);
      } finally {
        close();
      }
    });
  });
}

function markRecord({
  monotonicMs = 1,
  name = "mark",
  recordId,
  sampleId,
}: {
  readonly monotonicMs?: number;
  readonly name?: string;
  readonly recordId: string;
  readonly sampleId: SampleId;
}): RawRecord {
  const clockDomainId = createClockDomainId(`clock:${sampleId}`);
  return {
    actor: "worker",
    at: {
      clockDomainId,
      id: createObservationId(`observation:${recordId}`),
      monotonicMs,
    },
    attemptId: createAttemptId(`attempt:${sampleId}`),
    clockDomainId,
    host: { id: "local", role: "worker", target: "local" },
    kind: "mark",
    name,
    processInstanceId: createProcessInstanceId("process:local"),
    recordId: createRecordId(recordId),
    runtime: "inline",
    sampleId,
    schemaVersion: 1,
  };
}
