import { OpenTelemetry } from "#compiled/@ai-sdk/otel/index.js";
import { registerTelemetry, type Telemetry } from "ai";

import { createEveOtelBridge } from "#harness/eve-otel-bridge.js";
import { isLocalDevTracingEnabled } from "#harness/local-dev-tracing-mode.js";

let registered = false;

/**
 * Registers the AI SDK telemetry integration once. Local dev uses eve's bridge
 * so the local trace tree is session-rooted; production keeps the existing
 * `@ai-sdk/otel` integration and its observable span behavior.
 */
export function ensureOtelIntegration(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerTelemetry(createOtelIntegration());
}

/** Resolves the integration for the current runtime mode. */
export function createOtelIntegration(): Telemetry {
  return isLocalDevTracingEnabled()
    ? createEveOtelBridge()
    : new OpenTelemetry({ runtimeContext: true });
}
