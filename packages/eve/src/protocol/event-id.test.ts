import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEventId,
  EVENT_ID_BODY_LENGTH,
  EVENT_ID_PREFIX,
  isEventId,
} from "#protocol/event-id.js";

const CROCKFORD_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

afterEach(() => {
  vi.useRealTimers();
});

describe("createEventId", () => {
  it("produces a prefixed 26-character Crockford base32 body", () => {
    const id = createEventId();

    expect(id.startsWith(EVENT_ID_PREFIX)).toBe(true);
    const body = id.slice(EVENT_ID_PREFIX.length);
    expect(body).toHaveLength(EVENT_ID_BODY_LENGTH);
    expect(body).toMatch(CROCKFORD_BODY);
  });

  it("never repeats an id across a large batch", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 100_000; index += 1) {
      ids.add(createEventId());
    }

    expect(ids.size).toBe(100_000);
  });

  it("sorts in emission order even when many ids share one millisecond", () => {
    // A single turn emits far more than one event per millisecond, so a
    // non-monotonic generator would scramble `ORDER BY id` for exactly the
    // events consumers most want ordered.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));

    const ids = Array.from({ length: 500 }, () => createEventId());

    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts later timestamps after earlier ones", () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    const earlier = createEventId();
    vi.setSystemTime(new Date("2026-07-27T00:00:01.000Z"));
    const later = createEventId();

    expect(earlier < later).toBe(true);
  });

  it("stays monotonic when the clock moves backwards", () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-07-27T00:00:05.000Z"));
    const first = createEventId();
    vi.setSystemTime(new Date("2026-07-27T00:00:04.000Z"));
    const second = createEventId();

    expect(first < second).toBe(true);
  });
});

describe("isEventId", () => {
  it("accepts ids this module mints", () => {
    expect(isEventId(createEventId())).toBe(true);
  });

  it("rejects a missing prefix, a wrong length, or a non-Crockford character", () => {
    const body = createEventId().slice(EVENT_ID_PREFIX.length);

    expect(isEventId(body)).toBe(false);
    expect(isEventId(`${EVENT_ID_PREFIX}${body.slice(1)}`)).toBe(false);
    expect(isEventId(`${EVENT_ID_PREFIX}U${body.slice(1)}`)).toBe(false);
  });
});
