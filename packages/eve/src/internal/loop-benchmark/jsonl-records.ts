import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { RawRecord } from "#internal/loop-benchmark/contract.js";
import { parseRawRecordJson } from "#internal/loop-benchmark/parse-record.js";
import type { RawRecordWriter } from "#internal/loop-benchmark/recorder.js";

type AppendJsonlBatch = (path: string, jsonl: string) => Promise<void>;

const writesByPath = new Map<string, Promise<void>>();

/** Append-only JSONL writer for records produced by benchmark server processes. */
export class JsonlRawRecordWriter implements RawRecordWriter {
  readonly #appendBatch: AppendJsonlBatch;
  readonly #path: string;
  readonly #pending: RawRecord[] = [];

  constructor(path: string, options: { readonly appendBatch?: AppendJsonlBatch } = {}) {
    if (path.trim() === "") throw new TypeError("Loop benchmark record path cannot be empty.");
    this.#appendBatch = options.appendBatch ?? appendJsonlBatch;
    this.#path = resolve(path);
  }

  write(record: RawRecord): void {
    this.#pending.push(record);
  }

  flush(): Promise<void> {
    if (this.#pending.length === 0) {
      return writesByPath.get(this.#path) ?? Promise.resolve();
    }

    const records = this.#pending.splice(0);
    const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const previous = writesByPath.get(this.#path) ?? Promise.resolve();
    const write = previous.then(() => this.#appendBatch(this.#path, jsonl));
    writesByPath.set(this.#path, write);
    return write;
  }
}

async function appendJsonlBatch(path: string, jsonl: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, jsonl, "utf8");
}

/** Reads and validates every complete record in one benchmark JSONL file. */
export async function readLoopBenchmarkJsonlRecords(path: string): Promise<readonly RawRecord[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const records: RawRecord[] = [];
  const lines = source.split(/\r?\n/);
  if (!source.endsWith("\n")) lines.pop();
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      records.push(parseRawRecordJson(line));
    } catch (error) {
      throw new TypeError(`Invalid loop benchmark JSONL record at line ${String(index + 1)}.`, {
        cause: error,
      });
    }
  }
  return records;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
