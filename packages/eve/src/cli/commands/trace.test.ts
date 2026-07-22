import { describe, expect, it } from "vitest";

import type { RunSummary, WaterfallNode } from "#internal/tracing/index.js";

import { formatRunList, formatWaterfall, resolveTraceId } from "#cli/commands/trace.js";

function summary(overrides: Partial<RunSummary>): RunSummary {
  return {
    traceId: "0123456789abcdef",
    rootName: "ai.eve.turn",
    turnCount: 1,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    totalTokens: 15,
    durationMillis: 120,
    startedAtMillis: 0,
    spanCount: 2,
    ...overrides,
  };
}

function node(overrides: Partial<WaterfallNode>): WaterfallNode {
  return {
    spanId: "s1",
    name: "ai.eve.turn",
    kind: 0,
    depth: 0,
    offsetPct: 0,
    widthPct: 100,
    durationMillis: 120,
    startMillis: 0,
    endMillis: 120,
    attributes: {},
    ...overrides,
  };
}

describe("formatRunList", () => {
  it("renders an aligned table with a header row", () => {
    const lines = formatRunList([
      summary({ traceId: "aaaaaaaabbbbbbbb", trigger: "http", durationMillis: 120 }),
      summary({ traceId: "ccccccccdddddddd", trigger: "schedule", durationMillis: 2500 }),
    ]);

    // The session id column leads, replacing the old TRACE column.
    expect(lines[0]!.startsWith("SESSION")).toBe(true);
    expect(lines[0]).toContain("STARTED");
    expect(lines[0]).not.toContain("TRACE");
    // The full session id is shown (no truncation), so distinct sessions differ.
    expect(lines[1]!.startsWith("aaaaaaaabbbbbbbb")).toBe(true);
    expect(lines[1]).toContain("http");
    expect(lines[1]).toContain("120ms");
    // Sub-second durations stay in ms; a second or more switches to seconds.
    expect(lines[2]).toContain("2.50s");
    // STARTED is a readable date-time, not a raw ISO string with T/Z/millis.
    expect(lines[1]).toContain("1970-01-01 00:00:00");
    expect(lines[1]).not.toContain("T00:00:00");
    // Columns align: every row is padded to the same header offsets.
    expect(lines[1]!.indexOf("http")).toBe(lines[0]!.indexOf("TRIGGER"));
  });

  it("falls back to a dash for a missing trigger", () => {
    const [, row] = formatRunList([summary({ trigger: undefined })]);
    expect(row).toContain(" - ");
  });
});

describe("formatWaterfall", () => {
  it("indents each node by its depth", () => {
    const [root, child] = formatWaterfall([
      node({ name: "ai.eve.turn", depth: 0 }),
      node({ name: "ai.streamText.doStream", depth: 1 }),
    ]);
    // The bar track precedes the name; depth 1 adds two spaces before the name.
    expect(root).toContain(" ai.eve.turn ");
    expect(child).toContain("   ai.streamText.doStream ");
  });

  it("positions the bar by offset and width across the fixed track", () => {
    const [full] = formatWaterfall([node({ offsetPct: 0, widthPct: 100 })]);
    expect(full!.startsWith("█".repeat(40))).toBe(true);

    const [half] = formatWaterfall([node({ offsetPct: 50, widthPct: 50 })]);
    const track = half!.slice(0, 40);
    expect(track).toBe("░".repeat(20) + "█".repeat(20));
  });

  it("draws at least one filled cell for a near-zero width span", () => {
    const [tiny] = formatWaterfall([node({ offsetPct: 0, widthPct: 0.1 })]);
    expect(tiny!.slice(0, 40)).toBe("█" + "░".repeat(39));
  });
});

describe("resolveTraceId", () => {
  const summaries = [summary({ traceId: "abc123" }), summary({ traceId: "abc999" })];

  it("resolves an exact id", () => {
    expect(resolveTraceId(summaries, "abc123")).toBe("abc123");
  });

  it("resolves an unambiguous prefix", () => {
    expect(resolveTraceId(summaries, "abc1")).toBe("abc123");
  });

  it("throws on an ambiguous prefix", () => {
    expect(() => resolveTraceId(summaries, "abc")).toThrow(/matches 2 traces/);
  });

  it("throws on an unknown reference", () => {
    expect(() => resolveTraceId(summaries, "zzz")).toThrow(/No trace matches/);
  });
});
