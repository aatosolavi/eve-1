import { appendFile, chmod, mkdir, open, readFile } from "node:fs/promises";

import type { Event } from "#compiled/@workflow/world/index.js";
import {
  decodePersistedSessionEvent,
  SessionEventTiming,
  WorkflowEventTiming,
} from "#internal/session-logs/event-timing.js";
import { resolveSessionLogDirectory, resolveSessionLogPath } from "#internal/session-logs/files.js";
import {
  formatOutputEvent,
  formatSessionEvent,
  formatWorkflowEvent,
  SESSION_EVENT_MARKER,
  sessionEventKey,
  WORKFLOW_EVENT_MARKER,
} from "#internal/session-logs/format.js";
import type { DevelopmentSessionLogEvent } from "#internal/session-logs/protocol.js";

const LOG_DIRECTORY_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

/** Serializes and deduplicates every append to one development session log. */
export class SessionLogSink {
  readonly #appRoot: string;
  readonly #eventIds = new Set<string>();
  #initialization: Promise<void> | undefined;
  readonly #knownSessionEvents = new Set<string>();
  #queue: Promise<void> = Promise.resolve();
  readonly #sessionId: string;
  readonly #sessionTiming = new SessionEventTiming();
  readonly #workflowTiming = new WorkflowEventTiming();

  constructor(input: { readonly appRoot: string; readonly sessionId: string }) {
    this.#appRoot = input.appRoot;
    this.#sessionId = input.sessionId;
  }

  appendOutputEvents(events: readonly DevelopmentSessionLogEvent[]): Promise<void> {
    return this.#enqueue(async () => {
      await this.#ensureInitialized();
      await this.#append(events.map(formatOutputEvent));
    });
  }

  appendSessionEventChunk(input: {
    readonly chunk: Uint8Array;
    readonly chunkIndex: number;
    readonly runId: string;
  }): Promise<void> {
    return this.#enqueue(async () => {
      await this.#ensureInitialized();
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
      await this.#ensureInitialized();
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
    await this.#queue;
  }

  async #append(blocks: readonly string[]): Promise<void> {
    if (blocks.length === 0) return;
    await appendFile(resolveSessionLogPath(this.#appRoot, this.#sessionId), blocks.join(""), {
      encoding: "utf8",
      mode: LOG_FILE_MODE,
    });
  }

  async #enqueue(callback: () => Promise<void>): Promise<void> {
    const current = this.#queue.catch(() => undefined).then(callback);
    this.#queue = current.then(
      () => undefined,
      () => undefined,
    );
    await current;
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#initialization !== undefined) {
      return await this.#initialization;
    }
    const initialization = this.#initialize();
    this.#initialization = initialization;
    try {
      await initialization;
    } catch (error) {
      if (this.#initialization === initialization) {
        this.#initialization = undefined;
      }
      throw error;
    }
  }

  async #initialize(): Promise<void> {
    const directory = resolveSessionLogDirectory(this.#appRoot);
    await mkdir(directory, { mode: LOG_DIRECTORY_MODE, recursive: true });
    await chmod(directory, LOG_DIRECTORY_MODE);
    const path = resolveSessionLogPath(this.#appRoot, this.#sessionId);
    try {
      const handle = await open(path, "wx", LOG_FILE_MODE);
      try {
        await handle.writeFile(
          [
            "# eve local session log",
            `# session: ${this.#sessionId}`,
            "# automatic recording: disable future writes with EVE_SESSION_LOGS=0",
            "# this file may contain model, tool, sandbox, stdout, and stderr data",
            "",
          ].join("\n"),
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isErrnoException(error, "EEXIST")) throw error;
    }
    await chmod(path, LOG_FILE_MODE);

    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(WORKFLOW_EVENT_MARKER)) {
      const eventId = match[1];
      if (eventId !== undefined) this.#eventIds.add(eventId);
    }
    for (const match of source.matchAll(SESSION_EVENT_MARKER)) {
      const [, runId, chunkIndex, lineIndex] = match;
      if (runId !== undefined && chunkIndex !== undefined && lineIndex !== undefined) {
        this.#knownSessionEvents.add(sessionEventKey(runId, Number(chunkIndex), Number(lineIndex)));
      }
    }
  }
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
