import { describe, expect, it } from "vitest";

import type { CapturedSpan } from "#internal/tracing/captured-span.js";
import { TraceRingBuffer } from "#internal/tracing/ring-buffer.js";

function span(traceId: string, spanId: string): CapturedSpan {
  return {
    traceId,
    spanId,
    name: "ai.eve.turn",
    kind: 0,
    startTimeUnixNano: "0",
    endTimeUnixNano: "1000000",
    startMillis: 0,
    endMillis: 1,
    attributes: {},
  };
}

describe("TraceRingBuffer", () => {
  it("groups spans by trace and returns them in arrival order", () => {
    const buffer = new TraceRingBuffer({ maxTraces: 10 });
    buffer.add(span("t1", "a"));
    buffer.add(span("t1", "b"));
    expect(buffer.getTrace("t1")?.map((s) => s.spanId)).toEqual(["a", "b"]);
    expect(buffer.listTraceIds()).toEqual(["t1"]);
  });

  it("evicts the least-recently-added trace past the cap and counts drops", () => {
    const buffer = new TraceRingBuffer({ maxTraces: 2 });
    buffer.add(span("t1", "a"));
    buffer.add(span("t2", "a"));
    buffer.add(span("t3", "a"));

    expect(buffer.getTrace("t1")).toBeUndefined();
    expect(buffer.listTraceIds()).toEqual(["t3", "t2"]);
    expect(buffer.droppedTraces).toBe(1);
  });

  it("adding another span to an existing trace does not count as a new trace", () => {
    const buffer = new TraceRingBuffer({ maxTraces: 1 });
    buffer.add(span("t1", "a"));
    buffer.add(span("t1", "b"));
    expect(buffer.droppedTraces).toBe(0);
    expect(buffer.getTrace("t1")).toHaveLength(2);
  });

  it("notifies subscribers of each captured span until unsubscribed", () => {
    const buffer = new TraceRingBuffer({ maxTraces: 10 });
    const seen: string[] = [];
    const unsubscribe = buffer.subscribe((s) => seen.push(s.spanId));
    buffer.add(span("t1", "a"));
    unsubscribe();
    buffer.add(span("t1", "b"));
    expect(seen).toEqual(["a"]);
  });

  it("rejects a nonsensical cap", () => {
    expect(() => new TraceRingBuffer({ maxTraces: 0 })).toThrow(/maxTraces/);
  });
});
