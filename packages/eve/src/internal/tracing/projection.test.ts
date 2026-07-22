import { describe, expect, it } from "vitest";

import type { CapturedAttributeValue, CapturedSpan } from "#internal/tracing/captured-span.js";
import { projectRunSummary, projectWaterfall } from "#internal/tracing/projection.js";

interface SpanInit {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMillis: number;
  endMillis: number;
  attributes?: Record<string, CapturedAttributeValue>;
}

function span(init: SpanInit): CapturedSpan {
  return {
    traceId: "t1",
    spanId: init.spanId,
    parentSpanId: init.parentSpanId,
    name: init.name,
    kind: 0,
    startTimeUnixNano: String(init.startMillis * 1_000_000),
    endTimeUnixNano: String(init.endMillis * 1_000_000),
    startMillis: init.startMillis,
    endMillis: init.endMillis,
    attributes: init.attributes ?? {},
  };
}

// A representative one-turn run: turn → step → (model call, tool call).
const run: CapturedSpan[] = [
  span({
    spanId: "turn",
    name: "ai.eve.turn",
    startMillis: 0,
    endMillis: 1000,
    attributes: {
      "eve.session.id": "sess-1",
      "eve.channel.kind": "slack",
      "eve.turn.id": "turn-1",
    },
  }),
  span({
    spanId: "step",
    parentSpanId: "turn",
    name: "ai.streamText",
    startMillis: 0,
    endMillis: 900,
  }),
  span({
    spanId: "model",
    parentSpanId: "step",
    name: "ai.streamText.doStream",
    startMillis: 100,
    endMillis: 500,
    attributes: { "gen_ai.usage.input_tokens": 200, "gen_ai.usage.output_tokens": 80 },
  }),
  span({
    spanId: "tool",
    parentSpanId: "step",
    name: "ai.toolCall",
    startMillis: 550,
    endMillis: 700,
  }),
];

describe("projectRunSummary", () => {
  it("derives trigger, session, turns, tokens, and duration", () => {
    const summary = projectRunSummary(run);
    expect(summary.traceId).toBe("t1");
    expect(summary.sessionId).toBe("sess-1");
    expect(summary.trigger).toBe("slack");
    expect(summary.turnCount).toBe(1);
    expect(summary.inputTokens).toBe(200);
    expect(summary.outputTokens).toBe(80);
    expect(summary.totalTokens).toBe(280);
    expect(summary.durationMillis).toBe(1000);
    expect(summary.rootName).toBe("ai.eve.turn");
  });

  it("counts each model call once, ignoring an ancestor's aggregate usage copy", () => {
    // Mirrors the AI SDK's `invoke_agent` (aggregate) wrapping `chat` (per-call):
    // the model call ("model") is a descendant of the aggregate ("agent"), so the
    // aggregate's 999 must not be summed on top of the child's 200.
    const withAggregate = [
      span({
        spanId: "agent",
        parentSpanId: "step",
        name: "invoke_agent",
        startMillis: 100,
        endMillis: 500,
        attributes: { "gen_ai.usage.input_tokens": 999 },
      }),
      ...run.map((s) => (s.spanId === "model" ? { ...s, parentSpanId: "agent" } : s)),
    ];
    expect(projectRunSummary(withAggregate).inputTokens).toBe(200);
  });

  it("throws on an empty span set", () => {
    expect(() => projectRunSummary([])).toThrow(/at least one span/);
  });
});

describe("projectWaterfall", () => {
  it("orders spans depth-first with correct nesting depth", () => {
    const nodes = projectWaterfall(run);
    expect(nodes.map((n) => `${n.name}@${n.depth}`)).toEqual([
      "ai.eve.turn@0",
      "ai.streamText@1",
      "ai.streamText.doStream@2",
      "ai.toolCall@2",
    ]);
  });

  it("computes offset and width as percentages of the run span", () => {
    const nodes = projectWaterfall(run);
    const model = nodes.find((n) => n.name === "ai.streamText.doStream")!;
    // model call runs 100–500ms within a 0–1000ms run.
    expect(model.offsetPct).toBeCloseTo(10);
    expect(model.widthPct).toBeCloseTo(40);
    const tool = nodes.find((n) => n.name === "ai.toolCall")!;
    expect(tool.offsetPct).toBeCloseTo(55);
    expect(tool.widthPct).toBeCloseTo(15);
  });

  it("keeps orphaned spans as roots rather than dropping them", () => {
    const orphan = [
      span({
        spanId: "x",
        parentSpanId: "missing",
        name: "ai.toolCall",
        startMillis: 0,
        endMillis: 10,
      }),
    ];
    const nodes = projectWaterfall(orphan);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.depth).toBe(0);
  });

  it("returns an empty timeline for no spans", () => {
    expect(projectWaterfall([])).toEqual([]);
  });

  it("prunes the always-'step 1' span and lifts its children to invoke_agent", () => {
    const withStep = [
      span({ spanId: "turn", name: "ai.eve.turn", startMillis: 0, endMillis: 1000 }),
      span({
        spanId: "agent",
        parentSpanId: "turn",
        name: "invoke_agent",
        startMillis: 0,
        endMillis: 900,
      }),
      span({
        spanId: "step",
        parentSpanId: "agent",
        name: "step 1",
        startMillis: 0,
        endMillis: 900,
      }),
      span({
        spanId: "model",
        parentSpanId: "step",
        name: "chat",
        startMillis: 10,
        endMillis: 500,
      }),
      span({
        spanId: "tool",
        parentSpanId: "step",
        name: "execute_tool get_weather",
        startMillis: 520,
        endMillis: 700,
      }),
    ];
    const nodes = projectWaterfall(withStep);
    expect(nodes.some((n) => n.name === "step 1")).toBe(false);
    // chat and the tool now hang directly off invoke_agent.
    expect(nodes.map((n) => `${n.name}@${n.depth}`)).toEqual([
      "ai.eve.turn@0",
      "invoke_agent@1",
      "chat@2",
      "execute_tool get_weather@2",
    ]);
    expect(nodes.find((n) => n.name === "chat")!.parentSpanId).toBe("agent");
  });

  it("hides workflow plumbing by default and reveals it in verbose mode", () => {
    const withPlumbing = [
      span({ spanId: "wf", name: "workflow.route.flow", startMillis: 0, endMillis: 1000 }),
      span({
        spanId: "wstep",
        parentSpanId: "wf",
        name: "step.execute",
        startMillis: 0,
        endMillis: 1000,
      }),
      span({
        spanId: "turn",
        parentSpanId: "wstep",
        name: "ai.eve.turn",
        startMillis: 0,
        endMillis: 990,
      }),
      span({
        spanId: "agent",
        parentSpanId: "turn",
        name: "invoke_agent",
        startMillis: 0,
        endMillis: 900,
      }),
      span({
        spanId: "chat",
        parentSpanId: "agent",
        name: "chat",
        startMillis: 10,
        endMillis: 500,
      }),
    ];

    const byDefault = projectWaterfall(withPlumbing);
    expect(byDefault.map((n) => n.name)).toEqual(["ai.eve.turn", "invoke_agent", "chat"]);
    expect(byDefault[0]!.depth).toBe(0); // turn re-rooted above the dropped plumbing

    const verbose = projectWaterfall(withPlumbing, { verbose: true }).map(
      (n) => `${n.name}@${n.depth}`,
    );
    expect(verbose).toEqual([
      "workflow.route.flow@0",
      "step.execute@1",
      "ai.eve.turn@2",
      "invoke_agent@3",
      "chat@4",
    ]);
  });
});
