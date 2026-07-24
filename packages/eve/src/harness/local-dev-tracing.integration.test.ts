import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";
import { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import {
  registerLocalDevTracing,
  resetLocalDevTracingForTesting,
  type LocalDevTracingHandle,
} from "#harness/local-dev-tracing.js";
import { projectRunSummary } from "#internal/tracing/index.js";

// A single registration for the whole file: the OpenTelemetry global tracer
// provider can only be set once per process, so the tests share one appRoot.
describe("registerLocalDevTracing", () => {
  let appRoot: string;
  let handle: LocalDevTracingHandle;

  beforeAll(async () => {
    resetLocalDevTracingForTesting();
    appRoot = await mkdtemp(join(tmpdir(), "eve-dev-tracing-"));
    handle = registerLocalDevTracing({ appRoot, agentName: "weather" });
  });

  afterAll(async () => {
    resetLocalDevTracingForTesting();
    await rm(appRoot, { recursive: true, force: true });
  });

  it("synthesizes an instrumentation config that enables telemetry", () => {
    const config = getInstrumentationConfig();
    expect(config).toBeDefined();
    expect(config?.functionId).toBe("weather");
    expect(config?.recordInputs).toBe(true);
    expect(config?.recordOutputs).toBe(true);
  });

  it("returns the same handle on repeated calls (idempotent)", () => {
    expect(registerLocalDevTracing({ appRoot, agentName: "other" })).toBe(handle);
  });

  it("captures the nested span tree emitted via the global tracer to the store", async () => {
    const tracer = trace.getTracer("eve");
    const turn = tracer.startSpan("ai.eve.turn", {
      attributes: { "eve.session.id": "sess-xyz", "eve.channel.kind": "slack" },
    });
    const turnContext = trace.setSpan(otelContext.active(), turn);
    otelContext.with(turnContext, () => {
      const model = tracer.startSpan("ai.streamText.doStream", {
        attributes: { "gen_ai.usage.input_tokens": 150, "gen_ai.usage.output_tokens": 60 },
      });
      model.end();
    });
    turn.end();

    await handle.flush();

    const runs = await handle.store.list();
    expect(runs).toHaveLength(1);

    const traceId = runs[0]!.traceId;
    const spans = await handle.store.read(traceId);
    expect(spans).toBeDefined();
    // Turn (root) + model call, both in one trace with the child nested.
    expect(spans!).toHaveLength(2);
    const model = spans!.find((span) => span.name === "ai.streamText.doStream")!;
    const root = spans!.find((span) => span.name === "ai.eve.turn")!;
    expect(model.parentSpanId).toBe(root.spanId);

    const summary = projectRunSummary(spans!);
    expect(summary.trigger).toBe("slack");
    expect(summary.sessionId).toBe("sess-xyz");
    expect(summary.inputTokens).toBe(150);
    expect(summary.outputTokens).toBe(60);
  });
});
