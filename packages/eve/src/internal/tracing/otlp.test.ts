import { describe, expect, it } from "vitest";

import type { CapturedSpan } from "#internal/tracing/captured-span.js";
import { capturedSpansToOtlp, otlpToCapturedSpans } from "#internal/tracing/otlp.js";

function span(overrides: Partial<CapturedSpan> = {}): CapturedSpan {
  return {
    traceId: "t1",
    spanId: "s1",
    name: "ai.eve.turn",
    kind: 0,
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "2000000000",
    startMillis: 1000,
    endMillis: 2000,
    attributes: {},
    ...overrides,
  };
}

describe("OTLP round-trip", () => {
  it("preserves span identity, timings, parent, and typed attributes", () => {
    const original: CapturedSpan[] = [
      span({
        name: "ai.eve.turn",
        attributes: { "eve.session.id": "abc", "eve.channel.kind": "slack" },
      }),
      span({
        spanId: "s2",
        parentSpanId: "s1",
        name: "ai.streamText.doStream",
        attributes: {
          "gen_ai.usage.input_tokens": 120,
          "ai.model.temperature": 0.7,
          "eve.stream": true,
          "eve.tags": ["a", "b"],
        },
        status: { code: 2, message: "boom" },
      }),
    ];

    const decoded = otlpToCapturedSpans(
      capturedSpansToOtlp(original, { "service.name": "weather" }),
    );

    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject({
      traceId: "t1",
      spanId: "s1",
      startMillis: 1000,
      endMillis: 2000,
      attributes: { "eve.session.id": "abc", "eve.channel.kind": "slack" },
    });
    const child = decoded[1]!;
    expect(child.parentSpanId).toBe("s1");
    expect(child.attributes["gen_ai.usage.input_tokens"]).toBe(120);
    expect(child.attributes["ai.model.temperature"]).toBe(0.7);
    expect(child.attributes["eve.stream"]).toBe(true);
    expect(child.attributes["eve.tags"]).toEqual(["a", "b"]);
    expect(child.status).toEqual({ code: 2, message: "boom" });
  });

  it("emits a standard ExportTraceServiceRequest shape", () => {
    const payload = capturedSpansToOtlp([span()], { "service.name": "eve" });
    const resourceSpans = payload.resourceSpans[0]!;
    expect(resourceSpans.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "eve" },
    });
    expect(resourceSpans.scopeSpans[0]!.scope.name).toBe("eve");
    expect(resourceSpans.scopeSpans[0]!.spans[0]!.traceId).toBe("t1");
  });

  it("encodes integers and doubles distinctly", () => {
    const payload = capturedSpansToOtlp([span({ attributes: { count: 3, ratio: 0.5 } })]);
    const attrs = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    expect(attrs).toContainEqual({ key: "count", value: { intValue: "3" } });
    expect(attrs).toContainEqual({ key: "ratio", value: { doubleValue: 0.5 } });
  });
});
