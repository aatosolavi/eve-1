import { registerTelemetry } from "ai";

import { createEveOtelBridge } from "#harness/eve-otel-bridge.js";

let registered = false;

/**
 * Registers the eve-owned AI SDK telemetry bridge once so that model calls
 * emit GenAI semantic-convention spans directly — no `@ai-sdk/otel`
 * dependency. Safe to call multiple times — only the first call has an effect.
 *
 * The bridge creates `invoke_agent`, `chat`, and `execute_tool` spans using
 * the same `"eve"` tracer as the session/turn spans, so the entire trace tree
 * shares one traceId. There is no intermediate `step {n}` wrapper.
 */
export function ensureOtelIntegration(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerTelemetry(createEveOtelBridge());
}
