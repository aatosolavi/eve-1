import { describe, expect, it } from "vitest";

import { assessBenchmarkCorrectness } from "./correctness.js";
import {
  createInvalidEvents,
  createValidEvents,
  reduceEvents,
  TEST_NONCE,
  TEST_VERIFICATION,
} from "./test-events.js";

describe("assessBenchmarkCorrectness", () => {
  it("accepts the exact two-step, one-tool benchmark transcript", () => {
    const events = createValidEvents();
    const result = assessBenchmarkCorrectness({
      events,
      nonce: TEST_NONCE,
      projection: reduceEvents(events),
    });

    expect(result).toEqual({
      finalVisibleMessage: TEST_VERIFICATION,
      kind: "valid",
    });
  });

  it("returns typed issues for a semantically invalid transcript", () => {
    const events = createInvalidEvents();
    const result = assessBenchmarkCorrectness({
      events,
      nonce: TEST_NONCE,
      projection: reduceEvents(events),
    });

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;

    expect(result.issues.map((issue) => issue.kind)).toEqual([
      "session-started-count",
      "message-received-count",
      "model-step-count",
      "tool-request-mismatch",
      "final-visible-message",
      "session-waiting-count",
    ]);
  });

  it("rejects a complete transcript whose canonical boundaries are out of order", () => {
    const events = createValidEvents();
    const reordered = [events[0], events[1], events[3], events[2], ...events.slice(4)].filter(
      (event) => event !== undefined,
    );

    const result = assessBenchmarkCorrectness({
      events: reordered,
      nonce: TEST_NONCE,
      projection: reduceEvents(reordered),
    });

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.issues.map((issue) => issue.kind)).toContain("protocol-event-order");
  });

  it("requires the benchmark tool request at model step zero", () => {
    const events = createValidEvents().map((event) =>
      event.type === "actions.requested"
        ? { ...event, data: { ...event.data, stepIndex: 1 } }
        : event,
    );

    const result = assessBenchmarkCorrectness({
      events,
      nonce: TEST_NONCE,
      projection: reduceEvents(events),
    });

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.issues.map((issue) => issue.kind)).toContain("tool-request-mismatch");
  });
});
