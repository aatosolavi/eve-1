import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapturedSpan } from "#internal/tracing/captured-span.js";
import { TraceStore } from "#internal/tracing/trace-store.js";
import { handleDevTraceViewerRequest } from "#internal/nitro/host/dev-trace-viewer/handler.js";

const TRACE_ID = "trace-fixture-1";

function fixtureSpans(): CapturedSpan[] {
  return [
    {
      traceId: TRACE_ID,
      spanId: `${TRACE_ID}-session`,
      name: "ai.eve.session",
      kind: 0,
      startTimeUnixNano: "0",
      endTimeUnixNano: String(100 * 1_000_000),
      startMillis: 0,
      endMillis: 100,
      attributes: { "eve.session.id": "sess-1" },
    },
    {
      traceId: TRACE_ID,
      spanId: `${TRACE_ID}-root`,
      parentSpanId: `${TRACE_ID}-session`,
      name: "ai.eve.turn",
      kind: 0,
      startTimeUnixNano: "0",
      endTimeUnixNano: String(100 * 1_000_000),
      startMillis: 0,
      endMillis: 100,
      attributes: { "eve.session.id": "sess-1", "eve.channel.kind": "http" },
    },
    {
      traceId: TRACE_ID,
      spanId: `${TRACE_ID}-model`,
      parentSpanId: `${TRACE_ID}-root`,
      name: "ai.streamText.doStream",
      kind: 0,
      startTimeUnixNano: String(10 * 1_000_000),
      endTimeUnixNano: String(90 * 1_000_000),
      startMillis: 10,
      endMillis: 90,
      attributes: { "gen_ai.usage.input_tokens": 42, "gen_ai.usage.output_tokens": 17 },
    },
  ];
}

function request(pathname: string): Request {
  return new Request(`http://127.0.0.1:3000${pathname}`, { method: "GET" });
}

describe("handleDevTraceViewerRequest", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-trace-viewer-"));
    await new TraceStore(appRoot).write(TRACE_ID, fixtureSpans());
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  it("serves the viewer SPA at GET /__traces", async () => {
    const response = await handleDevTraceViewerRequest({ appRoot, request: request("/__traces") });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/html");
    const body = await response!.text();
    expect(body).toContain('<div class="app">');
  });

  it("returns the runs list as JSON at GET /__traces/data", async () => {
    const response = await handleDevTraceViewerRequest({
      appRoot,
      request: request("/__traces/data"),
    });
    expect(response?.status).toBe(200);
    const payload = (await response!.json()) as { runs: Array<{ traceId: string }> };
    expect(payload.runs.map((run) => run.traceId)).toContain(TRACE_ID);
  });

  it("returns a run's summary and waterfall at GET /__traces/data/<traceId>", async () => {
    const response = await handleDevTraceViewerRequest({
      appRoot,
      request: request(`/__traces/data/${TRACE_ID}`),
    });
    expect(response?.status).toBe(200);
    const payload = (await response!.json()) as {
      summary: { traceId: string; trigger?: string; totalTokens: number };
      waterfall: unknown[];
    };
    expect(payload.summary.traceId).toBe(TRACE_ID);
    expect(payload.summary.trigger).toBe("http");
    expect(payload.summary.totalTokens).toBe(59);
    expect(payload.waterfall.length).toBeGreaterThan(0);
  });

  it("returns 404 JSON for an unknown trace", async () => {
    const response = await handleDevTraceViewerRequest({
      appRoot,
      request: request("/__traces/data/does-not-exist"),
    });
    expect(response?.status).toBe(404);
  });

  it("falls through for unrelated paths under the namespace", async () => {
    const response = await handleDevTraceViewerRequest({
      appRoot,
      request: request("/__traces/other"),
    });
    expect(response).toBeUndefined();
  });
});
