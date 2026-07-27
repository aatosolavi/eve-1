import type { StampedHandleMessageStreamEvent } from "#protocol/message.js";

/**
 * Default number of event ids a deduper remembers before evicting the oldest.
 *
 * Duplicates only arise from stream overlap — a reconnect, a rewind, or an
 * initial replay stitched to a live tail — so the window that matters is the
 * recent past. The cap bounds memory on long-lived sessions.
 */
export const DEFAULT_EVENT_DEDUPE_CAPACITY = 10_000;

/**
 * Remembers which session-stream events have already been consumed.
 *
 * Every event carries a stable `meta.id` that survives reconnects, rewinds,
 * and replays, so re-delivery of the same durable chunk is exactly an id we
 * have already recorded.
 */
export type EventDeduper = {
  /**
   * Records `event` and reports whether it had already been recorded.
   *
   * Mutates: the first call for an id returns `false` and remembers it, and
   * every later call for that id returns `true`.
   */
  isDuplicate(event: StampedHandleMessageStreamEvent): boolean;
  /** Number of ids currently remembered. */
  readonly size: number;
};

/**
 * Creates an {@link EventDeduper} that remembers up to `capacity` event ids.
 *
 * Eviction is insertion-ordered: once the window is full, remembering a new id
 * forgets the oldest. Events arrive in stream order, so the forgotten ids are
 * the ones a reconnect can no longer re-deliver.
 *
 * @example
 * ```ts
 * const deduper = createEventDeduper();
 * for await (const event of session.stream()) {
 *   if (deduper.isDuplicate(event)) continue;
 *   render(event);
 * }
 * ```
 */
export function createEventDeduper(capacity: number = DEFAULT_EVENT_DEDUPE_CAPACITY): EventDeduper {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new TypeError(`event deduper capacity must be a positive integer, received ${capacity}`);
  }

  const seen = new Set<string>();

  return {
    isDuplicate(event) {
      const id = event.meta.id;
      if (seen.has(id)) return true;
      seen.add(id);
      if (seen.size > capacity) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      return false;
    },
    get size() {
      return seen.size;
    },
  };
}
