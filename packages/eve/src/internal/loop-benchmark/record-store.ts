import { DatabaseSync } from "node:sqlite";

import type { RawRecord, SampleId } from "#internal/loop-benchmark/contract.js";
import { parseRawRecord } from "#internal/loop-benchmark/parse-record.js";

export interface LoopBenchmarkRecordStore {
  append(records: readonly RawRecord[]): Promise<void>;
  read(sampleId: SampleId): Promise<readonly RawRecord[]>;
}

interface StoredRecord {
  readonly json: string;
  readonly recordId: string;
  readonly sampleId: string;
}

export class MemoryLoopBenchmarkRecordStore implements LoopBenchmarkRecordStore {
  readonly #records: StoredRecord[] = [];
  readonly #recordsById = new Map<string, StoredRecord>();

  async append(records: readonly RawRecord[]): Promise<void> {
    const pending = new Map<string, StoredRecord>();

    for (const record of records) {
      const stored = serializeRecord(record);
      const existing = this.#recordsById.get(record.recordId) ?? pending.get(record.recordId);
      if (existing !== undefined) {
        assertIdenticalReplay(existing, stored);
        continue;
      }
      pending.set(record.recordId, stored);
    }

    for (const stored of pending.values()) {
      this.#recordsById.set(stored.recordId, stored);
      this.#records.push(stored);
    }
  }

  async read(sampleId: SampleId): Promise<readonly RawRecord[]> {
    return this.#records.filter((record) => record.sampleId === sampleId).map(parseStoredRecord);
  }
}

export class SqliteLoopBenchmarkRecordStore implements LoopBenchmarkRecordStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS loop_benchmark_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT NOT NULL UNIQUE,
        sample_id TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS loop_benchmark_records_sample_sequence
        ON loop_benchmark_records (sample_id, sequence);
    `);
  }

  async append(records: readonly RawRecord[]): Promise<void> {
    const findById = this.#database.prepare(
      "SELECT record_id, sample_id, record_json FROM loop_benchmark_records WHERE record_id = ?",
    );
    const insert = this.#database.prepare(
      `INSERT INTO loop_benchmark_records (record_id, sample_id, record_json)
       VALUES (?, ?, ?)`,
    );

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) {
        const stored = serializeRecord(record);
        const row = findById.get(record.recordId);
        if (row !== undefined) {
          assertIdenticalReplay(parseStoredRow(row), stored);
          continue;
        }
        insert.run(stored.recordId, stored.sampleId, stored.json);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  async read(sampleId: SampleId): Promise<readonly RawRecord[]> {
    const rows = this.#database
      .prepare(
        `SELECT record_id, sample_id, record_json
         FROM loop_benchmark_records
         WHERE sample_id = ?
         ORDER BY sequence`,
      )
      .all(sampleId);

    return rows.map((row) => parseStoredRecord(parseStoredRow(row)));
  }
}

function assertIdenticalReplay(existing: StoredRecord, candidate: StoredRecord): void {
  if (existing.json !== candidate.json) {
    throw new Error(`Record "${candidate.recordId}" was retried with different JSON.`);
  }
}

function parseStoredRecord(stored: StoredRecord): RawRecord {
  const record = parseRawRecord(JSON.parse(stored.json) as unknown);
  if (record.recordId !== stored.recordId) {
    throw new TypeError(`Stored record JSON does not match record ID "${stored.recordId}".`);
  }
  if (record.sampleId !== stored.sampleId) {
    throw new TypeError(`Stored record JSON does not match sample ID "${stored.sampleId}".`);
  }
  return record;
}

function parseStoredRow(row: Record<string, unknown>): StoredRecord {
  const recordId = row.record_id;
  const sampleId = row.sample_id;
  const json = row.record_json;
  if (typeof recordId !== "string" || typeof sampleId !== "string" || typeof json !== "string") {
    throw new TypeError("Stored loop benchmark record row has an unsupported shape.");
  }
  return { json, recordId, sampleId };
}

function serializeRecord(record: RawRecord): StoredRecord {
  const json = JSON.stringify(record);
  if (json === undefined) {
    throw new TypeError(`Record "${record.recordId}" cannot be serialized as JSON.`);
  }
  return { json, recordId: record.recordId, sampleId: record.sampleId };
}
