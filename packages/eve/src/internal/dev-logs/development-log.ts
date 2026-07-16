import { appendFile, chmod, mkdir, open } from "node:fs/promises";
import { inspect } from "node:util";

import type { Event } from "#compiled/@workflow/world/index.js";
import {
  decodePersistedSessionEvent,
  SessionEventTiming,
  WorkflowEventTiming,
} from "#internal/dev-logs/event-timing.js";
import {
  resolveDevelopmentLogDirectory,
  resolveDevelopmentLogPath,
} from "#internal/dev-logs/files.js";
import {
  formatOutputEvent,
  formatSessionEvent,
  formatWorkflowEvent,
  sessionEventKey,
} from "#internal/dev-logs/format.js";
import type { DevelopmentLogEvent } from "#internal/dev-logs/protocol.js";

const LOG_DIRECTORY_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

/** Ordered writer for one owned `eve dev` invocation. */
export class DevelopmentLog {
  readonly #appRoot: string;
  readonly #eventIds = new Set<string>();
  readonly #knownSessionEvents = new Set<string>();
  readonly #logId: string;
  #queue: Promise<void> = Promise.resolve();
  readonly #sessionTiming = new SessionEventTiming();
  readonly #workflowTiming = new WorkflowEventTiming();

  private constructor(input: { readonly appRoot: string; readonly logId: string }) {
    this.#appRoot = input.appRoot;
    this.#logId = input.logId;
  }

  static async open(input: {
    readonly appRoot: string;
    readonly logId: string;
  }): Promise<DevelopmentLog> {
    const log = new DevelopmentLog(input);
    await log.#initialize();
    return log;
  }

  get path(): string {
    return resolveDevelopmentLogPath(this.#appRoot, this.#logId);
  }

  appendOutputEvents(events: readonly DevelopmentLogEvent[]): Promise<void> {
    return this.#enqueue(async () => await this.#append(events.map(formatOutputEvent)));
  }

  appendDiagnostic(input: {
    readonly at?: Date;
    readonly error?: unknown;
    readonly level: "error" | "info" | "warn";
    readonly message: string;
    readonly source: string;
  }): Promise<void> {
    return this.#enqueue(async () => {
      const at = (input.at ?? new Date()).toISOString();
      const detail =
        input.error === undefined
          ? ""
          : `${inspect(input.error, { colors: false, depth: null })}\n`;
      await this.#append([
        `[${at}] [diagnostic] level=${input.level} source=${input.source}\n${input.message}\n${detail}\n`,
      ]);
    });
  }

  appendSessionEventChunk(input: {
    readonly chunk: Uint8Array;
    readonly chunkIndex: number;
    readonly runId: string;
  }): Promise<void> {
    return this.#enqueue(async () => {
      const source = new TextDecoder().decode(input.chunk);
      const lines = source.split("\n").filter((line) => line.length > 0);
      const blocks: string[] = [];
      for (const [lineIndex, line] of lines.entries()) {
        const key = sessionEventKey(input.runId, input.chunkIndex, lineIndex);
        const decoded = decodePersistedSessionEvent(line);
        const metrics =
          decoded.event === undefined
            ? {}
            : this.#sessionTiming.observe(input.runId, decoded.event);
        if (this.#knownSessionEvents.has(key)) continue;
        blocks.push(
          formatSessionEvent({
            ...decoded,
            chunkIndex: input.chunkIndex,
            lineIndex,
            metrics,
            runId: input.runId,
          }),
        );
        this.#knownSessionEvents.add(key);
      }
      await this.#append(blocks);
    });
  }

  appendWorkflowEvents(events: readonly Event[]): Promise<void> {
    return this.#enqueue(async () => {
      const blocks: string[] = [];
      for (const event of events) {
        const metrics = this.#workflowTiming.observe(event);
        if (this.#eventIds.has(event.eventId)) continue;
        blocks.push(formatWorkflowEvent(event, metrics));
        this.#eventIds.add(event.eventId);
      }
      await this.#append(blocks);
    });
  }

  async close(): Promise<void> {
    await this.appendDiagnostic({
      level: "info",
      message: "eve dev invocation stopped",
      source: "dev.lifecycle",
    });
    await this.#queue;
  }

  async #append(blocks: readonly string[]): Promise<void> {
    if (blocks.length === 0) return;
    await appendFile(this.path, blocks.join(""), { encoding: "utf8", mode: LOG_FILE_MODE });
  }

  async #enqueue(callback: () => Promise<void>): Promise<void> {
    const current = this.#queue.catch(() => undefined).then(callback);
    this.#queue = current.then(
      () => undefined,
      () => undefined,
    );
    await current;
  }

  async #initialize(): Promise<void> {
    const directory = resolveDevelopmentLogDirectory(this.#appRoot);
    await mkdir(directory, { mode: LOG_DIRECTORY_MODE, recursive: true });
    await chmod(directory, LOG_DIRECTORY_MODE);
    const handle = await open(this.path, "wx", LOG_FILE_MODE);
    try {
      await handle.writeFile(
        [
          "# eve local development log",
          `# invocation: ${this.#logId}`,
          `# started: ${new Date().toISOString()}`,
          `# pid: ${String(process.pid)}`,
          "# automatic recording: disable with EVE_DEV_LOGS=0",
          "# this file may contain unredacted model, tool, sandbox, stdout, stderr, and error data",
          "",
          "",
        ].join("\n"),
      );
    } finally {
      await handle.close();
    }
    await chmod(this.path, LOG_FILE_MODE);
  }
}
