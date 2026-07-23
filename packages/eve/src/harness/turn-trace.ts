import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";
import type { TraceDependencies } from "#core/step-ports.js";
import { recordErrorOnSpan } from "#internal/logging.js";
import { resolveStepOtelContext, setTurnTraceState } from "#harness/otel-integration.js";
import type { HarnessStepFlow } from "#harness/step-flow.js";

/**
 * The tracing primitives of the core step flow, bound to OTel. The
 * envelope built from them — when a turn span opens, how it is stamped
 * onto the state, that the step body runs inside its context — is core
 * flow in `core/turn-call.ts`.
 */
export function createTraceDependencies(
  tracer: ReturnType<typeof trace.getTracer> | undefined,
): TraceDependencies<HarnessStepFlow> {
  return {
    bind: ({ state, trace: turnSpan }) => setTurnTraceState(state, turnSpan.spanContext()),

    end(turnSpan) {
      turnSpan.end();
    },

    async inContext({ state, trace: turnSpan }, run) {
      const parentContext = resolveStepOtelContext(tracer, turnSpan, state);
      if (parentContext) {
        return await otelContext.with(parentContext, run);
      }
      return await run();
    },

    recordError(turnSpan, error) {
      recordErrorOnSpan(turnSpan, error);
    },

    setAttribute(turnSpan, key, value) {
      turnSpan.setAttribute(key, value);
    },

    start(name, attributes) {
      return tracer === undefined ? undefined : tracer.startSpan(name, { attributes });
    },
  };
}
