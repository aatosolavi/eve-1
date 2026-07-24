import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getLocalDevInstrumentationRuntime } from "#harness/local-dev-instrumentation-runtime.js";
import {
  registerLocalDevTracing,
  resetLocalDevTracingForTesting,
  type LocalDevTracingHandle,
} from "#harness/local-dev-tracing.js";
import { projectRunSummary } from "#internal/tracing/index.js";

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

  it("registers a private local instrumentation runtime", () => {
    const runtime = getLocalDevInstrumentationRuntime();
    expect(runtime).toBeDefined();
    expect(runtime?.recordInputs).toBe(true);
    expect(runtime?.recordOutputs).toBe(true);
  });

  it("returns the same handle on repeated calls (idempotent)", () => {
    expect(registerLocalDevTracing({ appRoot, agentName: "other" })).toBe(handle);
  });

  it("captures a session-rooted AI lifecycle without global OTel state", async () => {
    const runtime = getLocalDevInstrumentationRuntime()!;
    const bridge = runtime.createBridge({
      attemptId: "turn-1:0:0",
      attemptIndex: 0,
      functionId: "weather",
      sessionId: "sess-xyz",
      stepIndex: 0,
      turnId: "turn-1",
    });

    Reflect.apply(bridge.onStart!, bridge, [
      {
        callId: "call-1",
        instructions: "Answer weather questions",
        messages: [],
        modelId: "claude-test",
        operationId: "ai.streamText",
        provider: "anthropic",
        runtimeContext: { "eve.channel.kind": "slack" },
      },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 0 }]);
    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "claude-test", provider: "anthropic" },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finishReason: "stop",
        performance: { responseTimeMs: 10 },
        responseId: "response-1",
        usage: { inputTokens: 150, outputTokens: 60 },
      },
    ]);
    Reflect.apply(bridge.onStepEnd!, bridge, [{ callId: "call-1" }]);
    await Reflect.apply(bridge.onEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finalStep: {},
        finishReason: "stop",
        usage: { inputTokens: 150, outputTokens: 60 },
      },
    ]);

    await handle.flush();

    const spans = await handle.store.read("sess-xyz");
    expect(spans).toBeDefined();
    expect(spans!.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        "ai.eve.session",
        "ai.eve.turn",
        "invoke_agent claude-test",
        "chat claude-test",
      ]),
    );
    const session = spans!.find((span) => span.name === "ai.eve.session")!;
    const turn = spans!.find((span) => span.name === "ai.eve.turn")!;
    const invoke = spans!.find((span) => span.name === "invoke_agent claude-test")!;
    const model = spans!.find((span) => span.name === "chat claude-test")!;
    expect(session.parentSpanId).toBeUndefined();
    expect(turn.parentSpanId).toBe(session.spanId);
    expect(invoke.parentSpanId).toBe(turn.spanId);
    expect(model.parentSpanId).toBe(invoke.spanId);

    const summary = projectRunSummary(spans!);
    expect(summary.sessionId).toBe("sess-xyz");
    expect(summary.inputTokens).toBe(150);
    expect(summary.outputTokens).toBe(60);
  });
});
