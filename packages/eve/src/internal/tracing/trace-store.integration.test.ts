import { mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapturedSpan } from "#internal/tracing/captured-span.js";
import { TraceStore } from "#internal/tracing/trace-store.js";

function span(
  traceId: string,
  spanId: string,
  startMillis: number,
  parentSpanId?: string,
): CapturedSpan {
  return {
    traceId,
    spanId,
    parentSpanId,
    name: parentSpanId === undefined ? "ai.eve.turn" : "ai.streamText.doStream",
    kind: 0,
    startTimeUnixNano: String(startMillis * 1_000_000),
    endTimeUnixNano: String((startMillis + 100) * 1_000_000),
    startMillis,
    endMillis: startMillis + 100,
    attributes:
      parentSpanId === undefined
        ? { "eve.session.id": `sess-${traceId}`, "eve.channel.kind": "http" }
        : { "gen_ai.usage.input_tokens": 10, "gen_ai.usage.output_tokens": 5 },
  };
}

function run(traceId: string, startMillis: number): CapturedSpan[] {
  return [
    span(traceId, `${traceId}-root`, startMillis),
    span(traceId, `${traceId}-model`, startMillis + 10, `${traceId}-root`),
  ];
}

describe("TraceStore", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-traces-"));
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  it("persists a run as OTLP/JSON and lists its summary", async () => {
    const store = new TraceStore(appRoot);
    await store.write("t1", run("t1", 0), { "service.name": "weather" });

    const summaries = await store.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      traceId: "t1",
      trigger: "http",
      inputTokens: 10,
      outputTokens: 5,
    });

    // A run is a subdirectory of OTLP segment files, one per captured step root.
    const raw = await readFile(join(store.directory, "t1", "t1-root.otlp.json"), "utf8");
    const parsed = JSON.parse(raw) as { resourceSpans: unknown[] };
    expect(parsed.resourceSpans).toHaveLength(1);
  });

  it("reads spans back through the OTLP round-trip", async () => {
    const store = new TraceStore(appRoot);
    await store.write("t1", run("t1", 0));
    const spans = await store.read("t1");
    expect(spans?.map((s) => s.spanId).sort()).toEqual(["t1-model", "t1-root"]);
  });

  it("returns undefined for an unknown trace", async () => {
    const store = new TraceStore(appRoot);
    expect(await store.read("missing")).toBeUndefined();
    expect(await store.readOtlp("missing")).toBeUndefined();
  });

  it("lists runs most-recent first", async () => {
    const store = new TraceStore(appRoot);
    await store.write("t1", run("t1", 1000));
    await store.write("t2", run("t2", 5000));
    await store.write("t3", run("t3", 3000));
    expect((await store.list()).map((s) => s.traceId)).toEqual(["t2", "t3", "t1"]);
  });

  it("lists from the summary sidecar without re-parsing segments", async () => {
    const store = new TraceStore(appRoot);
    await store.write("t1", run("t1", 0));

    // Drop the OTLP segments, leaving only summary.json. If list() still
    // reports the run, it read the sidecar rather than the (now absent) spans.
    const runDir = join(store.directory, "t1");
    for (const name of await readdir(runDir)) {
      if (name.endsWith(".otlp.json")) await unlink(join(runDir, name));
    }

    expect(await store.read("t1")).toBeUndefined();
    const summaries = await store.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ traceId: "t1", inputTokens: 10, outputTokens: 5 });
  });

  it("backfills a summary sidecar for a run captured without one", async () => {
    const store = new TraceStore(appRoot);
    await store.write("t1", run("t1", 0));
    await unlink(join(store.directory, "t1", "summary.json"));

    // The first list rebuilds the sidecar from segments...
    expect((await store.list()).map((s) => s.traceId)).toEqual(["t1"]);
    const raw = await readFile(join(store.directory, "t1", "summary.json"), "utf8");
    expect((JSON.parse(raw) as { traceId: string }).traceId).toBe("t1");
  });

  it("enforces the retention cap and prunes evicted trace files", async () => {
    const store = new TraceStore(appRoot, { maxTraces: 2 });
    await store.write("t1", run("t1", 1000));
    await store.write("t2", run("t2", 2000));
    await store.write("t3", run("t3", 3000));

    const summaries = await store.list();
    expect(summaries.map((s) => s.traceId)).toEqual(["t3", "t2"]);
    expect(await store.readOtlp("t1")).toBeUndefined();
  });
});
