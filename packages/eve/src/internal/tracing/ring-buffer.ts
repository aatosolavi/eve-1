import type { CapturedSpan } from "#internal/tracing/captured-span.js";

/** A listener notified as each finished span is captured (drives the live SSE feed). */
export type TraceSpanListener = (span: CapturedSpan) => void;

/**
 * A bounded, in-memory buffer of finished spans grouped by trace.
 *
 * Retains at most `maxTraces` traces, evicting the least-recently-added trace
 * when the cap is exceeded. Spans within a trace are kept in arrival order.
 * The dev web viewer reads snapshots from here and subscribes for live updates;
 * durable history lives in the on-disk trace store, not here.
 */
export class TraceRingBuffer {
  readonly #maxTraces: number;
  readonly #order: string[] = [];
  readonly #byTrace = new Map<string, CapturedSpan[]>();
  readonly #listeners = new Set<TraceSpanListener>();
  #droppedTraces = 0;

  constructor(options: { maxTraces: number }) {
    if (options.maxTraces < 1) throw new Error("TraceRingBuffer requires maxTraces >= 1.");
    this.#maxTraces = options.maxTraces;
  }

  /** Records a finished span and notifies live subscribers. */
  add(span: CapturedSpan): void {
    let spans = this.#byTrace.get(span.traceId);
    if (spans === undefined) {
      spans = [];
      this.#byTrace.set(span.traceId, spans);
      this.#order.push(span.traceId);
      this.#evictOverflow();
    }
    // A late span for an already-evicted trace re-creates the group above; that
    // is acceptable — the on-disk store holds the durable copy.
    spans.push(span);
    for (const listener of this.#listeners) listener(span);
  }

  /** Returns the spans for one trace in arrival order, or `undefined`. */
  getTrace(traceId: string): CapturedSpan[] | undefined {
    const spans = this.#byTrace.get(traceId);
    return spans === undefined ? undefined : [...spans];
  }

  /** Trace ids currently retained, most-recently-added first. */
  listTraceIds(): string[] {
    return [...this.#order].reverse();
  }

  /** Number of traces evicted due to the cap — surfaced so drops are never silent. */
  get droppedTraces(): number {
    return this.#droppedTraces;
  }

  /** Subscribes to captured spans. Returns an unsubscribe function. */
  subscribe(listener: TraceSpanListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #evictOverflow(): void {
    while (this.#order.length > this.#maxTraces) {
      const evicted = this.#order.shift();
      if (evicted === undefined) break;
      this.#byTrace.delete(evicted);
      this.#droppedTraces += 1;
    }
  }
}
