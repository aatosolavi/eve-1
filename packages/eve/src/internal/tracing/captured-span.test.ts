import { describe, expect, it } from "vitest";

import type { ReadableSpan } from "#compiled/@opentelemetry/sdk-trace-base/index.js";
import {
  capturedSpanFromReadable,
  hrTimeToUnixNano,
  redactPayloadAttributes,
  unixNanoToMillis,
  type CapturedAttributeValue,
} from "#internal/tracing/captured-span.js";

function fakeReadableSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: "ai.streamText.doStream",
    kind: 0,
    spanContext: () => ({ traceId: "trace-1", spanId: "span-1", traceFlags: 1 }),
    parentSpanContext: { traceId: "trace-1", spanId: "parent-1", traceFlags: 1 },
    startTime: [1, 500_000_000],
    endTime: [2, 250_000_000],
    status: { code: 1 },
    attributes: {},
    events: [],
    duration: [0, 750_000_000],
    ended: true,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...overrides,
  } as ReadableSpan;
}

describe("hrTime conversion", () => {
  it("converts HrTime to a Unix-nanosecond string without float loss", () => {
    expect(hrTimeToUnixNano([1, 500_000_000])).toBe("1500000000");
    expect(hrTimeToUnixNano([1_700_000_000, 123_456_789])).toBe("1700000000123456789");
  });

  it("converts a Unix-nano string back to fractional milliseconds", () => {
    expect(unixNanoToMillis("1500000000")).toBe(1500);
    expect(unixNanoToMillis("2250000000")).toBe(2250);
  });
});

describe("redactPayloadAttributes", () => {
  const attributes: Record<string, CapturedAttributeValue> = {
    "eve.session.id": "s1",
    "gen_ai.usage.input_tokens": 42,
    "ai.prompt.messages": "[secret prompt]",
    "ai.response.text": "[secret completion]",
    "ai.toolCall.args": "{query}",
    "ai.toolCall.result": "{rows}",
  };

  it("keeps everything when both inputs and outputs are recorded", () => {
    const result = redactPayloadAttributes(attributes, { recordInputs: true, recordOutputs: true });
    expect(Object.keys(result).sort()).toEqual(Object.keys(attributes).sort());
  });

  it("drops input payloads but keeps structural attributes when inputs are off", () => {
    const result = redactPayloadAttributes(attributes, {
      recordInputs: false,
      recordOutputs: true,
    });
    expect(result["ai.prompt.messages"]).toBeUndefined();
    expect(result["ai.toolCall.args"]).toBeUndefined();
    expect(result["eve.session.id"]).toBe("s1");
    expect(result["gen_ai.usage.input_tokens"]).toBe(42);
    expect(result["ai.response.text"]).toBe("[secret completion]");
  });

  it("drops output payloads when outputs are off", () => {
    const result = redactPayloadAttributes(attributes, {
      recordInputs: true,
      recordOutputs: false,
    });
    expect(result["ai.response.text"]).toBeUndefined();
    expect(result["ai.toolCall.result"]).toBeUndefined();
    expect(result["ai.prompt.messages"]).toBe("[secret prompt]");
  });
});

describe("capturedSpanFromReadable", () => {
  it("normalizes ids, timings, and parent from the span context", () => {
    const captured = capturedSpanFromReadable(fakeReadableSpan(), {
      recordInputs: true,
      recordOutputs: true,
    });
    expect(captured.traceId).toBe("trace-1");
    expect(captured.spanId).toBe("span-1");
    expect(captured.parentSpanId).toBe("parent-1");
    expect(captured.startMillis).toBe(1500);
    expect(captured.endMillis).toBe(2250);
    expect(captured.startTimeUnixNano).toBe("1500000000");
  });

  it("treats a root span (no parent context) as parentless", () => {
    const captured = capturedSpanFromReadable(
      fakeReadableSpan({ name: "ai.eve.turn", parentSpanContext: undefined }),
      { recordInputs: true, recordOutputs: true },
    );
    expect(captured.parentSpanId).toBeUndefined();
  });

  it("applies payload redaction to captured attributes", () => {
    const captured = capturedSpanFromReadable(
      fakeReadableSpan({ attributes: { "ai.prompt.messages": "secret", "eve.session.id": "s1" } }),
      { recordInputs: false, recordOutputs: true },
    );
    expect(captured.attributes["ai.prompt.messages"]).toBeUndefined();
    expect(captured.attributes["eve.session.id"]).toBe("s1");
  });
});
