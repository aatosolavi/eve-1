import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";
import type { TracePorts } from "#core/turn-call.js";
import type { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import { environment, eveVersion } from "#harness/model-call.js";
import { resolveStepOtelContext, setTurnTraceState } from "#harness/otel-integration.js";
import type { HarnessStepFlow, TurnSpanCell } from "#harness/step-flow.js";

/**
 * The observability-envelope ports of the core step flow
 * ({@link import("#core/turn-call.js").generateStep}), bound to OTel: the
 * turn span opened on a turn's first step, the span context stamped onto
 * the session for continuation steps, and the step body run inside the
 * span's (or restored parent's) context so AI SDK spans nest as children.
 */
export function createTracePorts(input: {
  readonly agentName: string | undefined;
  /** Shared with the flow ports, which record onto the open span. */
  readonly cell: TurnSpanCell;
  readonly telemetryConfig: ReturnType<typeof getInstrumentationConfig>;
  readonly tracer: ReturnType<typeof trace.getTracer> | undefined;
}): TracePorts<HarnessStepFlow> {
  const { agentName, cell, telemetryConfig, tracer } = input;

  return {
    openTurnTrace(state) {
      if (tracer === undefined) {
        return undefined;
      }
      const functionId = telemetryConfig?.functionId ?? agentName;
      const attributes: Record<string, string> = {
        "eve.version": eveVersion,
        "eve.environment": environment,
        "eve.session.id": state.sessionId,
      };
      if (functionId) {
        attributes["ai.telemetry.functionId"] = functionId;
      }
      cell.current = tracer.startSpan("ai.eve.turn", { attributes });
      return cell.current;
    },

    bindTurnTrace({ state, trace: turnSpan }) {
      return setTurnTraceState(state, turnSpan.spanContext());
    },

    async runInTraceContext({ state, trace: turnSpan }, run) {
      const parentContext = resolveStepOtelContext(tracer, turnSpan, state);
      if (parentContext) {
        return await otelContext.with(parentContext, run);
      }
      return await run();
    },

    endTurnTrace(turnSpan) {
      turnSpan.end();
    },
  };
}
