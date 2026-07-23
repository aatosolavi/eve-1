import { trace } from "#compiled/@opentelemetry/api/index.js";
import type { StepPorts } from "#core/step-ports.js";
import { generateStep } from "#core/turn-call.js";
import { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import { environment, eveVersion } from "#harness/model-call.js";
import { enrichTelemetry, ensureOtelIntegration } from "#harness/otel-integration.js";
import { createEventStream } from "#harness/step-events.js";
import { createStepFacets, type HarnessStepFlow } from "#harness/step-flow.js";
import {
  createCompactionDependencies,
  createModelDependencies,
  createPromptDependencies,
  createWaitDependencies,
} from "#harness/turn-before-call.js";
import {
  createCallDependencies,
  createFailureDependencies,
  createFlowLog,
  createSettleDependencies,
  createUsageDependencies,
} from "#harness/turn-call.js";
import { createTraceDependencies } from "#harness/turn-trace.js";
import type { GenerateConfig, GenerateFn } from "#harness/types.js";

/**
 * Creates a generate harness step function backed by AI SDK
 * `ToolLoopAgent`: the production implementation of the core `generate`
 * port. The step itself is the core
 * {@link import("#core/turn-call.js").generateStep} program; this module
 * only binds its dependency ports.
 */
export function createGenerate(config: GenerateConfig): GenerateFn {
  const telemetryConfig = getInstrumentationConfig();
  if (telemetryConfig !== undefined) {
    ensureOtelIntegration();
  }
  const tracer = telemetryConfig !== undefined ? trace.getTracer("eve") : undefined;
  const agentName = config.runtimeIdentity?.agentName;

  const ports: StepPorts<HarnessStepFlow> = {
    call: createCallDependencies({ agentName, config, telemetryConfig }),
    compaction: createCompactionDependencies({
      config,
      telemetry: enrichTelemetry(telemetryConfig, agentName) ?? undefined,
    }),
    events: createEventStream(config),
    facets: createStepFacets(),
    failure: createFailureDependencies(),
    identity: {
      environment,
      eveVersion,
      functionId: telemetryConfig?.functionId ?? agentName,
    },
    log: createFlowLog(),
    mode: config.mode,
    model: createModelDependencies(config),
    prompt: createPromptDependencies(),
    settle: createSettleDependencies(config),
    trace: createTraceDependencies(tracer),
    usage: createUsageDependencies(config),
    waits: createWaitDependencies(config),
  };

  return (session, input) => generateStep(ports, { input, state: session });
}
