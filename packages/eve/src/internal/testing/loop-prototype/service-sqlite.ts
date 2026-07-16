import { DatabaseSync } from "node:sqlite";

import type { PrototypeService } from "./service-contract.js";
import {
  type EffectLedger,
  EffectProtocolError,
  executeScriptedEffect,
} from "./service-effects.js";
import type {
  EffectCall,
  EventLogId,
  EventRecord,
  SessionId,
  StreamEvent,
  TerminalOutcome,
  WireValue,
} from "./types.js";
import { parseJsonWireValue, stringifyWireValue } from "./wire.js";

export class SqlitePrototypeService implements PrototypeService, EffectLedger {
  readonly #database: DatabaseSync;
  readonly databasePath: string;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS attempts (
        operation_id TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS visible_effects (
        operation_id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS callbacks (
        session_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effect_executions (
        operation_id TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS effect_results (
        operation_id TEXT PRIMARY KEY,
        result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        log_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(log_id, sequence)
      );
    `);
  }

  async append(logId: EventLogId, event: StreamEvent): Promise<EventRecord> {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const record = this.#appendEvent(logId, event);
      this.#database.exec("COMMIT");
      return record;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  attemptCount(operationId: string): number {
    const row = this.#database
      .prepare("SELECT count FROM attempts WHERE operation_id = ?")
      .get(operationId) as { readonly count: number } | undefined;
    return row?.count ?? 0;
  }

  callback(sessionId: string): TerminalOutcome | null {
    const row = this.#database
      .prepare("SELECT outcome FROM callbacks WHERE session_id = ?")
      .get(sessionId) as { readonly outcome: string } | undefined;
    return row === undefined ? null : parseTerminalOutcome(row.outcome);
  }

  commitResult(call: EffectCall, result: string): string {
    this.#database
      .prepare("INSERT OR IGNORE INTO effect_results (operation_id, result) VALUES (?, ?)")
      .run(call.id, result);
    const committed = this.committedResult(call);
    if (committed === null) {
      throw new EffectProtocolError(`Effect result "${call.id}" was not committed.`);
    }
    if (committed !== result) {
      throw new EffectProtocolError(`Effect result "${call.id}" was retried with different bytes.`);
    }
    return committed;
  }

  committedResult(call: EffectCall): string | null {
    const row = this.#database
      .prepare("SELECT result FROM effect_results WHERE operation_id = ?")
      .get(call.id) as { readonly result: string } | undefined;
    return row?.result ?? null;
  }

  async close(): Promise<void> {
    this.#database.close();
  }

  async effect(call: EffectCall): Promise<WireValue> {
    return await executeScriptedEffect(this, call);
  }

  executionCount(operationId: string): number {
    const row = this.#database
      .prepare("SELECT count FROM effect_executions WHERE operation_id = ?")
      .get(operationId) as { readonly count: number } | undefined;
    return row?.count ?? 0;
  }

  finish(sessionId: SessionId, outcome: TerminalOutcome): void {
    this.recordCallback(sessionId, outcome);
  }

  recordAttempt(call: EffectCall): number {
    this.#database
      .prepare(
        `INSERT INTO attempts (operation_id, count) VALUES (?, 1)
         ON CONFLICT(operation_id) DO UPDATE SET count = count + 1`,
      )
      .run(call.id);
    return this.attemptCount(call.id);
  }

  recordCallback(sessionId: string, outcome: TerminalOutcome): void {
    const value = JSON.stringify(outcome);
    const existing = this.#database
      .prepare("SELECT outcome FROM callbacks WHERE session_id = ?")
      .get(sessionId) as { readonly outcome: string } | undefined;
    if (existing !== undefined && existing.outcome !== value) {
      throw new EffectProtocolError(`Conflicting callback for session "${sessionId}".`);
    }
    this.#database
      .prepare("INSERT OR IGNORE INTO callbacks (session_id, outcome) VALUES (?, ?)")
      .run(sessionId, value);
  }

  recordExecution(call: EffectCall): void {
    this.#database
      .prepare(
        `INSERT INTO effect_executions (operation_id, count) VALUES (?, 1)
         ON CONFLICT(operation_id) DO UPDATE SET count = count + 1`,
      )
      .run(call.id);
  }

  recordVisibleEffect(call: EffectCall): void {
    const value = JSON.stringify({ input: call.input, name: call.name });
    const existing = this.#database
      .prepare("SELECT value FROM visible_effects WHERE operation_id = ?")
      .get(call.id) as { readonly value: string } | undefined;
    if (existing !== undefined && existing.value !== value) {
      throw new EffectProtocolError(`Conflicting visible effect for operation "${call.id}".`);
    }
    this.#database
      .prepare("INSERT OR IGNORE INTO visible_effects (operation_id, value) VALUES (?, ?)")
      .run(call.id, value);
  }

  async read(logId: EventLogId): Promise<readonly EventRecord[]> {
    const rows = this.#database
      .prepare(
        `SELECT event_id, log_id, sequence, operation_id, payload
         FROM events WHERE log_id = ? ORDER BY sequence`,
      )
      .all(logId);

    return rows.map(parseEventRow);
  }

  visibleEffectCount(operationId: string): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM visible_effects WHERE operation_id = ?")
      .get(operationId) as { readonly count: number };
    return row.count;
  }

  #appendEvent(logId: EventLogId, event: StreamEvent): EventRecord {
    const payload = stringifyWireValue(event.payload);
    const existing = this.#database
      .prepare(`SELECT log_id, sequence, operation_id, payload FROM events WHERE event_id = ?`)
      .get(event.id) as
      | {
          readonly log_id: string;
          readonly operation_id: string;
          readonly payload: string;
          readonly sequence: number;
        }
      | undefined;

    if (existing !== undefined) {
      if (
        existing.log_id !== logId ||
        existing.operation_id !== event.operationId ||
        existing.payload !== payload
      ) {
        throw new Error(`Event "${event.id}" was retried with different bytes.`);
      }
      return {
        ...event,
        logId,
        sequence: existing.sequence,
      };
    }

    const sequenceRow = this.#database
      .prepare("SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM events WHERE log_id = ?")
      .get(logId) as { readonly sequence: number };
    const record: EventRecord = { ...event, logId, sequence: sequenceRow.sequence };

    this.#database
      .prepare(
        `INSERT INTO events (event_id, log_id, sequence, operation_id, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.logId, record.sequence, record.operationId, payload);
    return record;
  }
}

function parseEventRow(row: Record<string, unknown>): EventRecord {
  const { event_id, log_id, operation_id, payload, sequence } = row;
  if (
    typeof event_id !== "string" ||
    typeof log_id !== "string" ||
    typeof operation_id !== "string" ||
    typeof payload !== "string" ||
    typeof sequence !== "number"
  ) {
    throw new TypeError("Stored event row has an unsupported shape.");
  }

  return {
    id: event_id as EventRecord["id"],
    logId: log_id as EventRecord["logId"],
    operationId: operation_id as EventRecord["operationId"],
    payload: parseJsonWireValue(payload),
    sequence,
  };
}

function parseTerminalOutcome(value: string): TerminalOutcome {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
    throw new TypeError("Stored callback is not a terminal outcome.");
  }
  if (parsed.kind === "completed" && "output" in parsed) {
    return { kind: "completed", output: parseJsonWireValue(JSON.stringify(parsed.output)) };
  }
  if (
    parsed.kind === "failed" &&
    "error" in parsed &&
    typeof parsed.error === "object" &&
    parsed.error !== null &&
    "code" in parsed.error &&
    "message" in parsed.error &&
    typeof parsed.error.code === "string" &&
    typeof parsed.error.message === "string"
  ) {
    return { error: { code: parsed.error.code, message: parsed.error.message }, kind: "failed" };
  }
  throw new TypeError("Stored callback has an unsupported terminal outcome shape.");
}
