import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";
import { createEveOtelBridge } from "#harness/eve-otel-bridge.js";
import { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import { isLocalDevTracingEnabled } from "#harness/local-dev-tracing-mode.js";
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
    expect(isLocalDevTracingEnabled()).toBe(true);
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

  it("keeps AI SDK bridge spans in the session-keyed run", async () => {
    const tracer = trace.getTracer("eve");
    const session = tracer.startSpan("ai.eve.session", {
      attributes: { "eve.session.id": "sess-bridge" },
    });
    const sessionContext = trace.setSpan(otelContext.active(), session);

    let turn: ReturnType<typeof tracer.startSpan> | undefined;
    otelContext.with(sessionContext, () => {
      turn = tracer.startSpan("ai.eve.turn", {
        attributes: { "eve.session.id": "sess-bridge" },
      });
    });
    const turnContext = trace.setSpan(sessionContext, turn!);
    const bridge = createEveOtelBridge();

    otelContext.with(turnContext, () => {
      Reflect.apply(bridge.onStart!, bridge, [
        {
          callId: "call-bridge",
          operationId: "ai.streamText",
          provider: "anthropic",
          modelId: "claude-test",
          runtimeContext: { "eve.session.id": "sess-bridge" },
        },
      ]);
      Reflect.apply(bridge.onEnd!, bridge, [
        {
          callId: "call-bridge",
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ]);
    });

    turn!.end();
    session.end();
    await handle.flush();

    const spans = await handle.store.read("sess-bridge");
    expect(spans).toBeDefined();
    const turnSpan = spans!.find((span) => span.name === "ai.eve.turn")!;
    const invokeSpan = spans!.find((span) => span.name === "invoke_agent claude-test")!;
    expect(invokeSpan.parentSpanId).toBe(turnSpan.spanId);
    expect(invokeSpan.traceId).toBe(turnSpan.traceId);

    // Without eve.session.id from runtimeContext, the processor would create
    // a second run keyed by the underlying OTel trace id.
    expect(await handle.store.read(invokeSpan.traceId)).toBeUndefined();
  });
});
