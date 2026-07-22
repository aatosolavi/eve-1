import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapturedSpan } from "#internal/tracing/index.js";
import { TraceStore } from "#internal/tracing/index.js";

import {
  runTraceExportCommand,
  runTraceListCommand,
  runTraceShowCommand,
} from "#cli/commands/trace.js";

function capturingLogger() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    logger: {
      log: (message: string) => lines.push(message),
      error: (message: string) => errors.push(message),
    },
  };
}

function fixtureRun(traceId: string, startMillis: number): CapturedSpan[] {
  const root: CapturedSpan = {
    traceId,
    spanId: `${traceId}-root`,
    name: "ai.eve.turn",
    kind: 0,
    startTimeUnixNano: String(startMillis * 1_000_000),
    endTimeUnixNano: String((startMillis + 200) * 1_000_000),
    startMillis,
    endMillis: startMillis + 200,
    attributes: { "eve.session.id": `sess-${traceId}`, "eve.channel.kind": "http" },
  };
  const model: CapturedSpan = {
    traceId,
    spanId: `${traceId}-model`,
    parentSpanId: `${traceId}-root`,
    name: "ai.streamText.doStream",
    kind: 0,
    startTimeUnixNano: String((startMillis + 20) * 1_000_000),
    endTimeUnixNano: String((startMillis + 120) * 1_000_000),
    startMillis: startMillis + 20,
    endMillis: startMillis + 120,
    attributes: { "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 5 },
  };
  return [root, model];
}

describe("eve trace commands", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-trace-cli-"));
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  it("lists an empty store with a friendly message", async () => {
    const { lines, logger } = capturingLogger();
    await runTraceListCommand(logger, appRoot);
    expect(lines).toEqual(["No traces found under .eve/traces."]);
  });

  it("lists captured runs as a table and as JSON", async () => {
    const store = new TraceStore(appRoot);
    await store.write("t1", fixtureRun("t1", 0));

    const table = capturingLogger();
    await runTraceListCommand(table.logger, appRoot);
    expect(table.lines[0]).toContain("SESSION");
    expect(table.lines[1]).toContain("http");
    expect(table.lines[1]).toContain("10");
    expect(table.lines[1]).toContain("5");

    const asJson = capturingLogger();
    await runTraceListCommand(asJson.logger, appRoot, { json: true });
    const parsed = JSON.parse(asJson.lines.join("\n")) as Array<{ traceId: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.traceId).toBe("t1");
  });

  it("renders the most recent run's waterfall when no id is given", async () => {
    const store = new TraceStore(appRoot);
    await store.write("t1", fixtureRun("t1", 0));
    await store.write("t2", fixtureRun("t2", 5000));

    const { lines, logger } = capturingLogger();
    await runTraceShowCommand(logger, appRoot);
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes("ai.eve.turn"))).toBe(true);
    // The child model span is indented deeper than the root.
    const child = lines.find((line) => line.includes("ai.streamText.doStream"))!;
    expect(child).toMatch(/█.* {2,}ai\.streamText\.doStream/);
  });

  it("resolves a trace by unambiguous prefix and can dump OTLP", async () => {
    const store = new TraceStore(appRoot);
    await store.write("abc123", fixtureRun("abc123", 0));

    const { lines, logger } = capturingLogger();
    await runTraceShowCommand(logger, appRoot, "abc1", { json: true });
    const parsed = JSON.parse(lines.join("\n")) as { resourceSpans: unknown[] };
    expect(parsed.resourceSpans).toHaveLength(1);
  });

  it("errors when showing an unknown trace", async () => {
    const store = new TraceStore(appRoot);
    await store.write("t1", fixtureRun("t1", 0));
    const { logger } = capturingLogger();
    await expect(runTraceShowCommand(logger, appRoot, "nope")).rejects.toThrow(/No trace matches/);
  });

  it("exports OTLP to an injected poster", async () => {
    const store = new TraceStore(appRoot);
    await store.write("t1", fixtureRun("t1", 0));

    const posted: { url: string; body: string }[] = [];
    const { lines, logger } = capturingLogger();
    await runTraceExportCommand(logger, appRoot, "t1", {
      otlp: "http://collector.local/v1/traces",
      post: async (url, body) => {
        posted.push({ url, body });
        return { status: 202 };
      },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("http://collector.local/v1/traces");
    const body = JSON.parse(posted[0]!.body) as { resourceSpans: unknown[] };
    expect(body.resourceSpans).toHaveLength(1);
    expect(lines[0]).toContain("HTTP 202");
  });

  it("prints OTLP to stdout without --otlp", async () => {
    const store = new TraceStore(appRoot);
    await store.write("t1", fixtureRun("t1", 0));

    const { lines, logger } = capturingLogger();
    await runTraceExportCommand(logger, appRoot, "t1");
    const parsed = JSON.parse(lines.join("\n")) as { resourceSpans: unknown[] };
    expect(parsed.resourceSpans).toHaveLength(1);
  });

  it("errors when exporting an unknown trace", async () => {
    const { logger } = capturingLogger();
    await expect(runTraceExportCommand(logger, appRoot, "missing")).rejects.toThrow(
      /No trace matches/,
    );
  });
});
