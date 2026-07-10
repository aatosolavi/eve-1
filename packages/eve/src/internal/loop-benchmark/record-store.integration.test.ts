import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAttemptId,
  createClockDomainId,
  createObservationId,
  createProcessInstanceId,
  createRecordId,
  createSampleId,
  type RawRecord,
} from "#internal/loop-benchmark/contract.js";
import { SqliteLoopBenchmarkRecordStore } from "#internal/loop-benchmark/record-store.js";

describe("SQLite loop benchmark record store persistence", () => {
  it("reads records after the explicit-path database is closed and reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-loop-benchmark-store-"));
    const databasePath = join(directory, "records.sqlite");
    const sampleId = createSampleId("sample-1");
    const clockDomainId = createClockDomainId("clock:local");
    const record = {
      actor: "worker",
      at: {
        clockDomainId,
        id: createObservationId("observation:record-1"),
        monotonicMs: 1,
      },
      attemptId: createAttemptId("attempt:sample-1"),
      clockDomainId,
      host: { id: "local", role: "worker", target: "local" },
      kind: "mark",
      name: "persisted",
      processInstanceId: createProcessInstanceId("process:local"),
      recordId: createRecordId("record-1"),
      runtime: "inline",
      sampleId,
      schemaVersion: 1,
    } satisfies RawRecord;

    try {
      const first = new SqliteLoopBenchmarkRecordStore(databasePath);
      try {
        await first.append([record]);
      } finally {
        first.close();
      }

      const reopened = new SqliteLoopBenchmarkRecordStore(databasePath);
      try {
        await expect(reopened.read(sampleId)).resolves.toEqual([record]);
      } finally {
        reopened.close();
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
