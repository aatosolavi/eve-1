import { context as otelContext, type Span, trace } from "#compiled/@opentelemetry/api/index.js";
import { generateStep, type StepPorts } from "#core/turn-call.js";
import { hasStepInput } from "#harness/input-requests.js";
import { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import { environment, eveVersion } from "#harness/model-call.js";
import {
  enrichTelemetry,
  ensureOtelIntegration,
  resolveStepOtelContext,
  setTurnTraceState,
} from "#harness/otel-integration.js";
import type { HarnessStepFlow } from "#harness/step-flow.js";
import { createBeforeCallPorts } from "#harness/turn-before-call.js";
import { createCallPorts } from "#harness/turn-call.js";
import type { GenerateOutcome, GenerateFn, StepInput, GenerateConfig } from "#harness/types.js";

/**
 * Creates a generate harness step function backed by AI SDK
 * `ToolLoopAgent`: the production implementation of the core `generate`
 * port. The step's flow — pre-call resolution, prompt assembly, call
 * preflight, the model call with recovery, settlement — is the core
 * {@link generateStep} program; this module only hosts it inside the turn
 * span's OTel context and binds the harness ports.
 */
export function createGenerate(config: GenerateConfig): GenerateFn {
  const telemetryConfig = getInstrumentationConfig();
  if (telemetryConfig !== undefined) {
    ensureOtelIntegration();
  }
  const tracer = telemetryConfig !== undefined ? trace.getTracer("eve") : undefined;
  const agentName = config.runtimeIdentity?.agentName;

  return async function runStep(
    initialSession: Readonly<Parameters<GenerateFn>[0]>,
    input?: StepInput,
  ): Promise<GenerateOutcome> {
    // First step of a turn: open a new parent span. Continuation steps
    // restore the parent from session state via resolveStepOtelContext.
    let turnSpan: Span | undefined;
    if (tracer && hasStepInput(input)) {
      const functionId = telemetryConfig?.functionId ?? agentName;
      const attributes: Record<string, string> = {
        "eve.version": eveVersion,
        "eve.environment": environment,
        "eve.session.id": initialSession.sessionId,
      };
      if (functionId) {
        attributes["ai.telemetry.functionId"] = functionId;
      }
      turnSpan = tracer.startSpan("ai.eve.turn", { attributes });
    }

    const executeStep = (): Promise<GenerateOutcome> => {
      // Store the turn span context on the session so continuation steps
      // can restore the parent trace across step boundaries.
      const session = turnSpan
        ? setTurnTraceState(initialSession, turnSpan.spanContext())
        : initialSession;

      const ports: StepPorts<HarnessStepFlow> = {
        ...createBeforeCallPorts({
          config,
          telemetry: enrichTelemetry(telemetryConfig, agentName) ?? undefined,
          turnSpan,
        }),
        ...createCallPorts({ agentName, config, telemetryConfig, turnSpan }),
      };

      return generateStep(ports, { input, state: session });
    };

    // Run the step inside the turn span's (or restored parent's) OTel
    // context so AI SDK spans nest as children.
    const parentContext = resolveStepOtelContext(tracer, turnSpan, initialSession);
    try {
      if (parentContext) {
        return await otelContext.with(parentContext, executeStep);
      }
      return await executeStep();
    } finally {
      turnSpan?.end();
    }
  };
}
