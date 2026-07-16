import { getWorkflowRunStreamId } from "#compiled/@workflow/core/util.js";
import type { Event, World } from "#compiled/@workflow/world/index.js";
import type { DevelopmentLogEvent } from "#internal/dev-logs/protocol.js";
import type { DevelopmentLog } from "#internal/dev-logs/development-log.js";

interface FetchedEvents {
  readonly cursor: string | undefined;
  readonly events: readonly Event[];
}

interface StreamFollower {
  readonly name: string;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly runId: string;
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

/** Reconciles committed Workflow data into the current `eve dev` invocation log. */
export class DevelopmentLogRecorder {
  readonly #backgroundTasks = new Set<Promise<void>>();
  readonly #eventCursorByRun = new Map<string, string>();
  readonly #followers = new Map<string, FollowerState>();
  readonly #log: DevelopmentLog;
  readonly #reconciliationByRun = new Map<string, Promise<void>>();
  readonly #world: World;
  #closing = false;

  constructor(input: { readonly log: DevelopmentLog; readonly world: World }) {
    this.#log = input.log;
    this.#world = input.world;
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
          tailIndex,
        });
      }),
    );
    await Promise.allSettled(followers.map(async ({ reader }) => await reader.cancel()));
    await Promise.allSettled(followers.map(({ task }) => task));
  }

  async appendOutputEvents(events: readonly DevelopmentLogEvent[]): Promise<void> {
    await this.#log.appendOutputEvents(events);
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
      `failed to reconcile development log for ${runId}`,
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

  async #startStreamFollower(key: string, runId: string, name: string): Promise<void> {
    const { tailIndex } = await this.#world.streams.getInfo(runId, name);
    await this.#reconcileSessionEventChunks({ name, runId, tailIndex });
    if (this.#closing) return;

    const stream = await this.#world.streams.get(runId, name, tailIndex + 1);
    const reader = stream.getReader();
    let active: ActiveFollower | undefined;
    const task = this.#consumeSessionEventStream({
      nextChunkIndex: tailIndex + 1,
      reader,
      runId,
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
    const follower = { name, reader, runId, task } satisfies StreamFollower;
    active = { follower, kind: "active" };
    this.#followers.set(key, active);
  }

  async #consumeSessionEventStream(input: {
    readonly nextChunkIndex: number;
    readonly reader: ReadableStreamDefaultReader<Uint8Array>;
    readonly runId: string;
  }): Promise<void> {
    let chunkIndex = input.nextChunkIndex;
    for (;;) {
      const { done, value } = await input.reader.read();
      if (done) return;
      await this.#log.appendSessionEventChunk({ chunk: value, chunkIndex, runId: input.runId });
      chunkIndex++;
    }
  }

  async #reconcileSessionEventChunks(input: {
    readonly name: string;
    readonly runId: string;
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
        await this.#log.appendSessionEventChunk({
          chunk: chunk.data,
          chunkIndex: chunk.index,
          runId: input.runId,
        });
      }
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
  }

  async #reconcileRun(runId: string): Promise<void> {
    const events = await this.#fetchEvents(runId, this.#eventCursorByRun.get(runId));
    await this.#log.appendWorkflowEvents(events.events);
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
}

function followerKey(runId: string, name: string): string {
  return `${runId}:${name}`;
}
