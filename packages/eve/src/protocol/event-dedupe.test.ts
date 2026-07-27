import { describe, expect, it } from "vitest";

import { stampTestEvent } from "#internal/testing/events.js";
import { createEventDeduper, DEFAULT_EVENT_DEDUPE_CAPACITY } from "#protocol/event-dedupe.js";
import { stampMessageStreamEvent } from "#protocol/message.js";

function sessionStarted(index: number) {
  return stampTestEvent({ type: "session.started", data: {} }, index);
}

describe("createEventDeduper", () => {
  it("admits an event once and rejects every re-delivery of it", () => {
    const deduper = createEventDeduper();
    const event = sessionStarted(0);

    expect(deduper.isDuplicate(event)).toBe(false);
    expect(deduper.isDuplicate(event)).toBe(true);
    expect(deduper.isDuplicate(event)).toBe(true);
    expect(deduper.size).toBe(1);
  });

  it("keys on the event id rather than the payload", () => {
    const deduper = createEventDeduper();
    const data = {} as const;

    // Byte-identical payloads stamped as two distinct emissions are two
    // events, not a replay: both must pass.
    expect(deduper.isDuplicate(stampMessageStreamEvent({ type: "session.started", data }))).toBe(
      false,
    );
    expect(deduper.isDuplicate(stampMessageStreamEvent({ type: "session.started", data }))).toBe(
      false,
    );
    expect(deduper.size).toBe(2);
  });

  it("survives an overlapping replay of a stream prefix", () => {
    const deduper = createEventDeduper();
    const stream = [0, 1, 2, 3].map(sessionStarted);

    const first = stream.filter((event) => !deduper.isDuplicate(event));
    // A reconnect that rewinds past the cursor re-delivers the whole prefix.
    const second = stream.filter((event) => !deduper.isDuplicate(event));

    expect(first).toHaveLength(4);
    expect(second).toHaveLength(0);
  });

  it("evicts the oldest id once the window is full", () => {
    const deduper = createEventDeduper(2);
    const [a, b, c] = [sessionStarted(0), sessionStarted(1), sessionStarted(2)];

    expect(deduper.isDuplicate(a)).toBe(false);
    expect(deduper.isDuplicate(b)).toBe(false);
    expect(deduper.isDuplicate(c)).toBe(false);
    expect(deduper.size).toBe(2);

    // `a` fell out of the window; `b` and `c` are still remembered.
    expect(deduper.isDuplicate(b)).toBe(true);
    expect(deduper.isDuplicate(c)).toBe(true);
    expect(deduper.isDuplicate(a)).toBe(false);
  });

  it("never exceeds its capacity", () => {
    const deduper = createEventDeduper(8);
    for (let index = 0; index < 100; index += 1) {
      deduper.isDuplicate(sessionStarted(index));
    }
    expect(deduper.size).toBe(8);
  });

  it("rejects a capacity that cannot hold an event", () => {
    expect(() => createEventDeduper(0)).toThrow(TypeError);
    expect(() => createEventDeduper(-1)).toThrow(TypeError);
    expect(() => createEventDeduper(1.5)).toThrow(TypeError);
  });

  it("defaults to a bounded window", () => {
    expect(DEFAULT_EVENT_DEDUPE_CAPACITY).toBeGreaterThan(0);
    expect(createEventDeduper().size).toBe(0);
  });
});
