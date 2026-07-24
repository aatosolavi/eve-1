import { OpenTelemetry } from "#compiled/@ai-sdk/otel/index.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  disableLocalDevTracingModeForTesting,
  enableLocalDevTracingMode,
} from "#harness/local-dev-tracing-mode.js";
import { createOtelIntegration } from "#harness/otel-integration.js";

describe("createOtelIntegration", () => {
  afterEach(() => {
    disableLocalDevTracingModeForTesting();
  });

  it("keeps the existing @ai-sdk/otel integration outside local dev", () => {
    expect(createOtelIntegration()).toBeInstanceOf(OpenTelemetry);
  });

  it("uses the eve-owned bridge for local dev tracing", () => {
    enableLocalDevTracingMode();
    expect(createOtelIntegration()).not.toBeInstanceOf(OpenTelemetry);
  });
});
