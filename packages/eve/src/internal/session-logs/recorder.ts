import { appendFile, chmod, mkdir, open, readFile } from "node:fs/promises";

import type { Event, WorkflowRunWithoutData, World } from "#compiled/@workflow/world/index.js";
import {
  decodePersistedSessionEvent,
  SessionEventTiming,
  WorkflowEventTiming,
} from "#internal/session-logs/event-timing.js";
import { resolveSessionLogDirectory, resolveSessionLogPath } from "#internal/session-logs/files.js";
import {
  compareWorkflowEvents,
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

interface FetchedEvents {
  readonly cursor: string | undefined;
  readonly events: readonly Event[];
}

interface StreamFollower {
  readonly name: string;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly runId: string;
  readonly sessionId: string;
  readonly task: Promise<void>;
}

/**
 * Parent-process writer for one app's automatic development session logs.
 * It follows the durable eve event stream for model/tool/session data and
 * accepts only process and sandbox output that have no Workflow event source.
 */
export class DevelopmentSessionLogRecorder {
  readonly #appRoot: string;
  readonly #eventCursorByRun = new Map<string, string>();
  readonly #eventIdsBySession = new Map<string, Set<string>>();
  readonly #followers = new Map<string, Promise<void>>();
  readonly #knownSessionEventsBySession = new Map<string, Set<string>>();
  readonly #queueBySession = new Map<string, Promise<void>>();
  readonly #sessionTiming = new SessionEventTiming();
  readonly #streamFollowers = new Set<StreamFollower>();
  readonly #workflowTiming = new WorkflowEventTiming();
  readonly #world: World;
  #closing = false;

  constructor(input: { readonly appRoot: string; readonly world: World }) {
    this.#appRoot = input.appRoot;
    this.#world = input.world;
  }

  async start(): Promise<void> {
    const runs = await this.#listRuns();
    const runsBySession = new Map<string, WorkflowRunWithoutData[]>();
    for (const run of runs) {
      const sessionId = resolveLogSessionId(run);
      if (sessionId === undefined) continue;
      const group = runsBySession.get(sessionId) ?? [];
      group.push(run);
      runsBySession.set(sessionId, group);
    }

    for (const [sessionId, sessionRuns] of runsBySession) {
      await this.#enqueue(sessionId, async () => {
        const fetched = await Promise.all(
          sessionRuns.map(async (run) => ({
            events: await this.#fetchEvents(run.runId),
            runId: run.runId,
          })),
        );
        const events = fetched.flatMap((entry) => entry.events.events).sort(compareWorkflowEvents);
        await this.#appendWorkflowEvents(sessionId, events);
        for (const entry of fetched) {
          if (entry.events.cursor !== undefined) {
            this.#eventCursorByRun.set(entry.runId, entry.events.cursor);
          }
        }
      });
    }

    for (const run of runs) {
      const names = await this.#world.streams.list(run.runId);
      for (const name of names) {
        await this.followSessionEventStream(run.runId, name);
      }
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled(
      [...this.#streamFollowers].map(async (follower) => {
        const { tailIndex } = await this.#world.streams.getInfo(follower.runId, follower.name);
        await this.#reconcileSessionEventChunks({
          name: follower.name,
          runId: follower.runId,
          sessionId: follower.sessionId,
          tailIndex,
        });
      }),
    );
    await Promise.allSettled(
      [...this.#streamFollowers].map(async ({ reader }) => await reader.cancel()),
    );
    await Promise.allSettled([...this.#streamFollowers].map(({ task }) => task));
    await Promise.all(this.#queueBySession.values());
  }

  async record(event: DevelopmentSessionLogEvent): Promise<void> {
    await this.#enqueue(event.sessionId, async () => {
      await this.#ensureLogFile(event.sessionId);
      await this.#append(event.sessionId, formatOutputEvent(event));
    });
  }

  /** Starts one replay-then-live listener for an eve run's canonical event stream. */
  async followSessionEventStream(runId: string, name: string): Promise<void> {
    if (name !== defaultSessionEventStreamName(runId) || this.#closing) return;
    const key = `${runId}:${name}`;
    const existing = this.#followers.get(key);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const started = this.#startStreamFollower(runId, name);
    this.#followers.set(key, started);
    await started;
  }

  /** Reconciles every committed World event not yet projected for one Workflow run. */
  async reconcileRun(runId: string): Promise<void> {
    const run = await this.#world.runs.get(runId, { resolveData: "none" });
    const sessionId = resolveLogSessionId(run);
    if (sessionId === undefined) return;

    await this.#enqueue(sessionId, async () => {
      const events = await this.#fetchEvents(runId, this.#eventCursorByRun.get(runId));
      await this.#appendWorkflowEvents(sessionId, events.events);
      if (events.cursor !== undefined) {
        this.#eventCursorByRun.set(runId, events.cursor);
      }
    });
  }

  async #startStreamFollower(runId: string, name: string): Promise<void> {
    const run = await this.#world.runs.get(runId, { resolveData: "none" });
    const sessionId = resolveLogSessionId(run);
    if (sessionId === undefined || this.#closing) return;

    const { tailIndex } = await this.#world.streams.getInfo(runId, name);
    await this.#reconcileSessionEventChunks({ name, runId, sessionId, tailIndex });
    if (this.#closing) return;

    const stream = await this.#world.streams.get(runId, name, tailIndex + 1);
    const reader = stream.getReader();
    let follower: StreamFollower;
    const task = this.#consumeSessionEventStream({
      nextChunkIndex: tailIndex + 1,
      reader,
      runId,
      sessionId,
    }).finally(() => {
      this.#streamFollowers.delete(follower);
      reader.releaseLock();
    });
    follower = { name, reader, runId, sessionId, task };
    this.#streamFollowers.add(follower);
    void task.catch((error: unknown) => {
      if (!this.#closing) {
        console.error(`[eve:dev] failed to follow session events for ${runId}`, error);
      }
    });
  }

  async #consumeSessionEventStream(input: {
    readonly nextChunkIndex: number;
    readonly reader: ReadableStreamDefaultReader<Uint8Array>;
    readonly runId: string;
    readonly sessionId: string;
  }): Promise<void> {
    let chunkIndex = input.nextChunkIndex;
    for (;;) {
      const { done, value } = await input.reader.read();
      if (done) return;
      await this.#recordSessionEventChunk({
        chunk: value,
        chunkIndex,
        runId: input.runId,
        sessionId: input.sessionId,
      });
      chunkIndex++;
    }
  }

  async #reconcileSessionEventChunks(input: {
    readonly name: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly tailIndex: number;
  }): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.#world.streams.getChunks(input.runId, input.name, {
        cursor,
        limit: 1_000,
      });
      for (const chunk of page.data) {
        if (chunk.index > input.tailIndex) break;
        await this.#recordSessionEventChunk({
          chunk: chunk.data,
          chunkIndex: chunk.index,
          runId: input.runId,
          sessionId: input.sessionId,
        });
      }
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }

  async #recordSessionEventChunk(input: {
    readonly chunk: Uint8Array;
    readonly chunkIndex: number;
    readonly runId: string;
    readonly sessionId: string;
  }): Promise<void> {
    const source = new TextDecoder().decode(input.chunk);
    const lines = source.split("\n").filter((line) => line.length > 0);
    await this.#enqueue(input.sessionId, async () => {
      await this.#ensureLogFile(input.sessionId);
      const known = await this.#readKnownSessionEvents(input.sessionId);
      for (const [lineIndex, line] of lines.entries()) {
        const key = sessionEventKey(input.runId, input.chunkIndex, lineIndex);
        const decoded = decodePersistedSessionEvent(line);
        const metrics =
          decoded.event === undefined
            ? {}
            : this.#sessionTiming.observe(input.runId, decoded.event);
        if (known.has(key)) continue;
        await this.#append(
          input.sessionId,
          formatSessionEvent({
            ...decoded,
            chunkIndex: input.chunkIndex,
            lineIndex,
            metrics,
            runId: input.runId,
          }),
        );
        known.add(key);
      }
    });
  }

  async #appendWorkflowEvents(sessionId: string, events: readonly Event[]): Promise<void> {
    await this.#ensureLogFile(sessionId);
    const knownEventIds = await this.#readKnownWorkflowEventIds(sessionId);
    for (const event of events) {
      const metrics = this.#workflowTiming.observe(event);
      if (knownEventIds.has(event.eventId)) continue;
      await this.#append(sessionId, formatWorkflowEvent(event, metrics));
      knownEventIds.add(event.eventId);
    }
  }

  async #fetchEvents(runId: string, initialCursor?: string): Promise<FetchedEvents> {
    const events: Event[] = [];
    let cursor = initialCursor;
    do {
      const page = await this.#world.events.list({
        pagination: { cursor, limit: 1_000, sortOrder: "asc" },
        resolveData: "all",
        runId,
      });
      events.push(...page.data);
      if (!page.hasMore) {
        return { cursor: page.cursor ?? cursor, events };
      }
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    return { cursor, events };
  }

  async #listRuns(): Promise<readonly WorkflowRunWithoutData[]> {
    const runs: WorkflowRunWithoutData[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#world.runs.list({
        pagination: { cursor, limit: 1_000, sortOrder: "asc" },
        resolveData: "none",
      });
      runs.push(...page.data);
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
    return runs;
  }

  async #readKnownWorkflowEventIds(sessionId: string): Promise<Set<string>> {
    const existing = this.#eventIdsBySession.get(sessionId);
    if (existing !== undefined) return existing;
    const source = await readFile(resolveSessionLogPath(this.#appRoot, sessionId), "utf8");
    const eventIds = new Set<string>();
    for (const match of source.matchAll(WORKFLOW_EVENT_MARKER)) {
      const eventId = match[1];
      if (eventId !== undefined) eventIds.add(eventId);
    }
    this.#eventIdsBySession.set(sessionId, eventIds);
    return eventIds;
  }

  async #readKnownSessionEvents(sessionId: string): Promise<Set<string>> {
    const existing = this.#knownSessionEventsBySession.get(sessionId);
    if (existing !== undefined) return existing;
    const source = await readFile(resolveSessionLogPath(this.#appRoot, sessionId), "utf8");
    const keys = new Set<string>();
    for (const match of source.matchAll(SESSION_EVENT_MARKER)) {
      const [, runId, chunkIndex, lineIndex] = match;
      if (runId !== undefined && chunkIndex !== undefined && lineIndex !== undefined) {
        keys.add(sessionEventKey(runId, Number(chunkIndex), Number(lineIndex)));
      }
    }
    this.#knownSessionEventsBySession.set(sessionId, keys);
    return keys;
  }

  async #ensureLogFile(sessionId: string): Promise<void> {
    const directory = resolveSessionLogDirectory(this.#appRoot);
    await mkdir(directory, { mode: LOG_DIRECTORY_MODE, recursive: true });
    await chmod(directory, LOG_DIRECTORY_MODE);
    const path = resolveSessionLogPath(this.#appRoot, sessionId);
    try {
      const handle = await open(path, "wx", LOG_FILE_MODE);
      try {
        await handle.writeFile(
          [
            "# eve local session log",
            `# session: ${sessionId}`,
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
  }

  async #append(sessionId: string, block: string): Promise<void> {
    await appendFile(resolveSessionLogPath(this.#appRoot, sessionId), block, {
      encoding: "utf8",
      mode: LOG_FILE_MODE,
    });
  }

  async #enqueue(sessionId: string, callback: () => Promise<void>): Promise<void> {
    const previous = this.#queueBySession.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(callback);
    this.#queueBySession.set(
      sessionId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    await current;
  }
}

function resolveLogSessionId(run: WorkflowRunWithoutData): string | undefined {
  const type = run.attributes["$eve.type"];
  if (type === "session") return run.runId;
  const root = run.attributes["$eve.root"];
  return typeof root === "string" && root.length > 0 ? root : undefined;
}

function defaultSessionEventStreamName(runId: string): string | undefined {
  if (!runId.startsWith("wrun_")) return undefined;
  return `strm_${runId.slice("wrun_".length)}_user`;
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
