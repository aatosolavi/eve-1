import { describe, expect, it, vi } from "vitest";

import { createAiSdkHookBridge } from "#harness/ai-sdk-hook-bridge.js";
import {
  InstrumentationLifecyclePublisher,
  type InstrumentationAttemptScope,
  type InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";

const scope: InstrumentationAttemptScope = {
  attemptId: "turn-1:step-0:attempt-0",
  attemptIndex: 0,
  sessionId: "session-1",
  stepIndex: 0,
  turnId: "turn-1",
};

describe("createAiSdkHookBridge", () => {
  it("publishes normalized model lifecycle to every provider", async () => {
    const calls: string[] = [];
    const provider = (name: string): InstrumentationProviderDefinition => ({
      events: {
        "model.call": {
          before(event) {
            calls.push(`${name}:before:${event.id}`);
            return `${name}-state`;
          },
          after(event, state) {
            calls.push(`${name}:after:${event.id}:${String(state)}`);
          },
        },
      },
    });
    const publisher = new InstrumentationLifecyclePublisher([provider("a"), provider("b")]);
    const bridge = createAiSdkHookBridge(scope, publisher);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", modelId: "model", provider: "test", tools: undefined },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finishReason: "stop",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    const id = `${scope.attemptId}:model:call-1`;
    expect(calls).toEqual([
      `a:before:${id}`,
      `b:before:${id}`,
      `a:after:${id}:a-state`,
      `b:after:${id}:b-state`,
    ]);
  });

  it("composes execution adapters while executing the model exactly once", async () => {
    const order: string[] = [];
    const provider = (name: string): InstrumentationProviderDefinition => ({
      executionContext: {
        async runModelCall(_id, execute) {
          order.push(`${name}:enter`);
          const result = await execute();
          order.push(`${name}:exit`);
          return result;
        },
        runToolCall(_id, execute) {
          return execute();
        },
      },
    });
    const publisher = new InstrumentationLifecyclePublisher([provider("a"), provider("b")]);
    const bridge = createAiSdkHookBridge(scope, publisher);
    const execute = vi.fn(async () => "result");

    const result = await bridge.executeLanguageModelCall!({
      callId: "call-1",
      execute,
    });

    expect(result).toBe("result");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["a:enter", "b:enter", "b:exit", "a:exit"]);
  });

  it("isolates a failing provider from the remaining providers", async () => {
    const after = vi.fn();
    const publisher = new InstrumentationLifecyclePublisher([
      {
        events: {
          "model.call": {
            before() {
              throw new Error("provider failed");
            },
          },
        },
      },
      { events: { "model.call": { before: () => "state", after } } },
    ]);
    const bridge = createAiSdkHookBridge(scope, publisher);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", modelId: "model", provider: "test", tools: undefined },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finishReason: "stop",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    expect(after).toHaveBeenCalledOnce();
  });
});
