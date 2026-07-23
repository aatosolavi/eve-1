import { trace } from "#compiled/@opentelemetry/api/index.js";
import { generateStep, type StepPorts } from "#core/turn-call.js";
import { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import { enrichTelemetry, ensureOtelIntegration } from "#harness/otel-integration.js";
import type { HarnessStepFlow, TurnSpanCell } from "#harness/step-flow.js";
import { createBeforeCallPorts } from "#harness/turn-before-call.js";
import { createCallPorts } from "#harness/turn-call.js";
import { createTracePorts } from "#harness/turn-trace.js";
import type { GenerateConfig, GenerateFn } from "#harness/types.js";

/**
 * Creates a generate harness step function backed by AI SDK
 * `ToolLoopAgent`: the production implementation of the core `generate`
 * port. The step itself — trace envelope, pre-call resolution, prompt
 * assembly, call preflight, the model call with recovery, settlement — is
 * the core {@link generateStep} program; this module only binds its ports.
 */
export function createGenerate(config: GenerateConfig): GenerateFn {
  const telemetryConfig = getInstrumentationConfig();
  if (telemetryConfig !== undefined) {
    ensureOtelIntegration();
  }
  const tracer = telemetryConfig !== undefined ? trace.getTracer("eve") : undefined;
  const agentName = config.runtimeIdentity?.agentName;
  const telemetry = enrichTelemetry(telemetryConfig, agentName) ?? undefined;

  return (session, input) => {
    const turnSpan: TurnSpanCell = { current: undefined };
    const ports: StepPorts<HarnessStepFlow> = {
      ...createBeforeCallPorts({ config, telemetry, turnSpan }),
      ...createCallPorts({ agentName, config, telemetryConfig, turnSpan }),
      ...createTracePorts({ agentName, cell: turnSpan, telemetryConfig, tracer }),
    };
    return generateStep(ports, { input, state: session });
  };
}
