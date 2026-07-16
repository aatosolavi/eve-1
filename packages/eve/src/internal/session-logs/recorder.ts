import { getWorkflowRunStreamId } from "#compiled/@workflow/core/util.js";
import type { Event, WorkflowRunWithoutData, World } from "#compiled/@workflow/world/index.js";
import { compareWorkflowEvents } from "#internal/session-logs/format.js";
import type { DevelopmentSessionLogEvent } from "#internal/session-logs/protocol.js";
import { SessionLogSink } from "#internal/session-logs/session-log-sink.js";

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

interface StartingFollower {
  readonly kind: "starting";
  readonly task: Promise<void>;
}

interface ActiveFollower {
  readonly follower: StreamFollower;
  readonly kind: "active";
}

type FollowerState = ActiveFollower | StartingFollower;

/**
 * Parent-process observer that projects durable workflow and eve events into
 * per-session development logs. Process and sandbox output arrive separately
 * because they have no durable Workflow event source.
 */
export class DevelopmentSessionLogRecorder {
  readonly #appRoot: string;
  readonly #backgroundTasks = new Set<Promise<void>>();
  readonly #eventCursorByRun = new Map<string, string>();
  readonly #followers = new Map<string, FollowerState>();
  readonly #reconciliationByRun = new Map<string, Promise<void>>();
  readonly #sinks = new Map<string, SessionLogSink>();
  readonly #world: World;
  #closing = false;

  constructor(input: { readonly appRoot: string; readonly world: World }) {
    this.#appRoot = input.appRoot;
    this.#world = input.world;
  }

  start(): void {
    this.#runInBackground(
      this.#discoverExistingSessionData(),
      "failed to reconcile existing local session logs",
    );
  }

  async close(): Promise<void> {
    this.#closing = true;
    while (this.#backgroundTasks.size > 0) {
      await Promise.allSettled(this.#backgroundTasks);
    }

    const followers = this.#activeFollowers();
    await Promise.allSettled(
      followers.map(async (follower) => {
        const { tailIndex } = await this.#world.streams.getInfo(follower.runId, follower.name);
        await this.#reconcileSessionEventChunks({
          name: follower.name,
          runId: follower.runId,
          sessionId: follower.sessionId,
          tailIndex,
        });
      }),
    );
    await Promise.allSettled(followers.map(async ({ reader }) => await reader.cancel()));
    await Promise.allSettled(followers.map(({ task }) => task));
    await Promise.allSettled([...this.#sinks.values()].map(async (sink) => await sink.close()));
  }

  async appendOutputEvents(events: readonly DevelopmentSessionLogEvent[]): Promise<void> {
    const eventsBySession = new Map<string, DevelopmentSessionLogEvent[]>();
    for (const event of events) {
      const sessionEvents = eventsBySession.get(event.sessionId) ?? [];
      sessionEvents.push(event);
      eventsBySession.set(event.sessionId, sessionEvents);
    }
    await Promise.all(
      [...eventsBySession].map(
        async ([sessionId, sessionEvents]) =>
          await this.#sink(sessionId).appendOutputEvents(sessionEvents),
      ),
    );
  }

  observeRunCommitted(runId: string): void {
    if (this.#closing) return;
    const previous = this.#reconciliationByRun.get(runId) ?? Promise.resolve();
    const reconciliation = previous
      .catch(() => undefined)
      .then(async () => await this.#reconcileRun(runId));
    this.#reconciliationByRun.set(runId, reconciliation);
    this.#runInBackground(
      reconciliation.finally(() => {
        if (this.#reconciliationByRun.get(runId) === reconciliation) {
          this.#reconciliationByRun.delete(runId);
        }
      }),
      `failed to reconcile local session log for ${runId}`,
    );
  }

  observeSessionEventStream(runId: string, name: string): void {
    if (name !== getWorkflowRunStreamId(runId) || this.#closing) return;
    const key = followerKey(runId, name);
    if (this.#followers.has(key)) return;

    const task = this.#startStreamFollower(key, runId, name);
    const state: StartingFollower = { kind: "starting", task };
    this.#followers.set(key, state);
    this.#runInBackground(
      task.finally(() => {
        if (this.#followers.get(key) === state) {
          this.#followers.delete(key);
        }
      }),
      `failed to follow session events for ${runId}`,
    );
  }

  async #discoverExistingSessionData(): Promise<void> {
    const runs = await this.#listRuns();
    const runsBySession = new Map<string, WorkflowRunWithoutData[]>();
    for (const run of runs) {
      const sessionId = resolveLogSessionId(run);
      if (sessionId === undefined) continue;
      const sessionRuns = runsBySession.get(sessionId) ?? [];
      sessionRuns.push(run);
      runsBySession.set(sessionId, sessionRuns);
    }

    await Promise.all(
      [...runsBySession].map(async ([sessionId, sessionRuns]) => {
        const fetched = await Promise.all(
          sessionRuns.map(async (run) => ({
            events: await this.#fetchEvents(run.runId),
            runId: run.runId,
          })),
        );
        const events = fetched.flatMap((entry) => entry.events.events).sort(compareWorkflowEvents);
        await this.#sink(sessionId).appendWorkflowEvents(events);
        for (const entry of fetched) {
          if (entry.events.cursor !== undefined) {
            this.#eventCursorByRun.set(entry.runId, entry.events.cursor);
          }
        }
      }),
    );

    for (const run of runs) {
      const names = await this.#world.streams.list(run.runId);
      for (const name of names) {
        this.observeSessionEventStream(run.runId, name);
      }
    }
  }

  async #startStreamFollower(key: string, runId: string, name: string): Promise<void> {
    const run = await this.#world.runs.get(runId, { resolveData: "none" });
    const sessionId = resolveLogSessionId(run);
    if (sessionId === undefined || this.#closing) return;

    const { tailIndex } = await this.#world.streams.getInfo(runId, name);
    await this.#reconcileSessionEventChunks({ name, runId, sessionId, tailIndex });
    if (this.#closing) return;

    const stream = await this.#world.streams.get(runId, name, tailIndex + 1);
    const reader = stream.getReader();
    let active: ActiveFollower | undefined;
    const task = this.#consumeSessionEventStream({
      nextChunkIndex: tailIndex + 1,
      reader,
      runId,
      sessionId,
    })
      .catch((error: unknown) => {
        if (!this.#closing) {
          console.error(`[eve:dev] failed to follow session events for ${runId}`, error);
        }
      })
      .finally(() => {
        if (active !== undefined && this.#followers.get(key) === active) {
          this.#followers.delete(key);
        }
        reader.releaseLock();
      });
    const follower = { name, reader, runId, sessionId, task } satisfies StreamFollower;
    active = { follower, kind: "active" };
    this.#followers.set(key, active);
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
      await this.#sink(input.sessionId).appendSessionEventChunk({
        chunk: value,
        chunkIndex,
        runId: input.runId,
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
        await this.#sink(input.sessionId).appendSessionEventChunk({
          chunk: chunk.data,
          chunkIndex: chunk.index,
          runId: input.runId,
        });
      }
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }

  async #reconcileRun(runId: string): Promise<void> {
    const run = await this.#world.runs.get(runId, { resolveData: "none" });
    const sessionId = resolveLogSessionId(run);
    if (sessionId === undefined) return;

    const events = await this.#fetchEvents(runId, this.#eventCursorByRun.get(runId));
    await this.#sink(sessionId).appendWorkflowEvents(events.events);
    if (events.cursor !== undefined) {
      this.#eventCursorByRun.set(runId, events.cursor);
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

  #activeFollowers(): StreamFollower[] {
    return [...this.#followers.values()].flatMap((state) =>
      state.kind === "active" ? [state.follower] : [],
    );
  }

  #runInBackground(task: Promise<void>, message: string): void {
    let tracked: Promise<void>;
    tracked = task
      .catch((error: unknown) => {
        if (!this.#closing) {
          console.error(`[eve:dev] ${message}`, error);
        }
      })
      .finally(() => {
        this.#backgroundTasks.delete(tracked);
      });
    this.#backgroundTasks.add(tracked);
  }

  #sink(sessionId: string): SessionLogSink {
    const existing = this.#sinks.get(sessionId);
    if (existing !== undefined) return existing;
    const sink = new SessionLogSink({ appRoot: this.#appRoot, sessionId });
    this.#sinks.set(sessionId, sink);
    return sink;
  }
}

function resolveLogSessionId(run: WorkflowRunWithoutData): string | undefined {
  const type = run.attributes["$eve.type"];
  if (type === "session") return run.runId;
  const root = run.attributes["$eve.root"];
  return typeof root === "string" && root.length > 0 ? root : undefined;
}

function followerKey(runId: string, name: string): string {
  return `${runId}:${name}`;
}
