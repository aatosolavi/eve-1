import { mkdtemp, writeFile } from "node:fs/promises";
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
import {
  JsonlRawRecordWriter,
  readLoopBenchmarkJsonlRecords,
} from "#internal/loop-benchmark/jsonl-records.js";

describe("loop benchmark JSONL records", () => {
  it("appends flushed records and reads them through the raw-record parser", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-loop-benchmark-jsonl-"));
    const path = join(directory, "nested", "records.jsonl");
    const writer = new JsonlRawRecordWriter(path);
    const first = createMarkRecord("record-1", "sample-1", "engine.dispatch", 1);
    const second = createMarkRecord("record-2", "sample-2", "runtime.park.accepted", 2);

    writer.write(first);
    await writer.flush();
    writer.write(second);
    await writer.flush();

    await expect(readLoopBenchmarkJsonlRecords(path)).resolves.toEqual([first, second]);
  });

  it("serializes flushes from every writer sharing one path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-loop-benchmark-jsonl-"));
    const path = join(directory, "records.jsonl");
    const firstAppendStarted = deferred<void>();
    const releaseFirstAppend = deferred<void>();
    const appendedBatches: string[] = [];
    let appendOrdinal = 0;
    const appendBatch = async (_path: string, jsonl: string): Promise<void> => {
      const ordinal = appendOrdinal++;
      if (ordinal === 0) {
        firstAppendStarted.resolve(undefined);
        await releaseFirstAppend.promise;
      }
      appendedBatches.push(jsonl);
    };
    const dispatchWriter = new JsonlRawRecordWriter(path, { appendBatch });
    const stepWriter = new JsonlRawRecordWriter(path, { appendBatch });
    const parkWriter = new JsonlRawRecordWriter(path, { appendBatch });
    const dispatch = createMarkRecord("record-1", "sample-1", "engine.dispatch", 1);
    const step = createMarkRecord("record-2", "sample-1", "turn.step.operation", 2);
    const park = createMarkRecord("record-3", "sample-1", "runtime.park.accepted", 3);

    dispatchWriter.write(dispatch);
    const dispatchFlush = dispatchWriter.flush();
    await firstAppendStarted.promise;
    stepWriter.write(step);
    const stepFlush = stepWriter.flush();
    parkWriter.write(park);
    const parkFlush = parkWriter.flush();

    await Promise.resolve();
    expect(appendedBatches).toEqual([]);

    releaseFirstAppend.resolve(undefined);
    await Promise.all([dispatchFlush, stepFlush, parkFlush]);

    expect(appendedBatches).toEqual([
      `${JSON.stringify(dispatch)}\n`,
      `${JSON.stringify(step)}\n`,
      `${JSON.stringify(park)}\n`,
    ]);
  });

  it("returns no records before the configured file exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-loop-benchmark-jsonl-"));

    await expect(
      readLoopBenchmarkJsonlRecords(join(directory, "not-created.jsonl")),
    ).resolves.toEqual([]);
  });

  it("identifies the malformed JSONL line at the external boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-loop-benchmark-jsonl-"));
    const path = join(directory, "records.jsonl");
    await writeFile(
      path,
      `${JSON.stringify(createMarkRecord("record-1", "sample-1", "ok", 1))}\n{\n`,
    );

    await expect(readLoopBenchmarkJsonlRecords(path)).rejects.toThrow(
      "Invalid loop benchmark JSONL record at line 2",
    );
  });

  it("ignores an incomplete trailing line while another process is appending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-loop-benchmark-jsonl-"));
    const path = join(directory, "records.jsonl");
    const complete = createMarkRecord("record-1", "sample-1", "complete", 1);
    await writeFile(path, `${JSON.stringify(complete)}\n{"kind":`, "utf8");

    await expect(readLoopBenchmarkJsonlRecords(path)).resolves.toEqual([complete]);
  });
});

function createMarkRecord(
  recordId: string,
  sampleId: string,
  name: string,
  monotonicMs: number,
): RawRecord {
  const clockDomainId = createClockDomainId("test-clock");
  return {
    actor: "worker",
    at: {
      clockDomainId,
      id: createObservationId(`${recordId}-observation`),
      monotonicMs,
    },
    attemptId: createAttemptId("attempt-1"),
    clockDomainId,
    host: { id: "test-host", role: "worker", target: "local" },
    kind: "mark",
    name,
    processInstanceId: createProcessInstanceId("test-process"),
    recordId: createRecordId(recordId),
    runtime: "inline",
    sampleId: createSampleId(sampleId),
    schemaVersion: 1,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("Deferred promise was not initialized.");
  return { promise, resolve: resolvePromise };
}
