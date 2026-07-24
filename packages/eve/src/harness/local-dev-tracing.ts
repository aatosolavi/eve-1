import { context as otelContext, trace } from "#compiled/@opentelemetry/api/index.js";
import { BasicTracerProvider } from "#compiled/@opentelemetry/sdk-trace-base/index.js";
import { registerInstrumentationConfig } from "#harness/instrumentation-config.js";
import { createLogger, formatError } from "#internal/logging.js";
import {
  AlsContextManager,
  LocalSpanProcessor,
  TraceRingBuffer,
  TraceStore,
} from "#internal/tracing/index.js";
import type { InstrumentationDefinition } from "#public/instrumentation/index.js";

const log = createLogger("tracing.dev");

/** Env var that disables message-payload capture in zero-config dev tracing. */
export const EVE_TRACE_RECORD_INPUTS_ENV = "EVE_TRACE_RECORD_INPUTS";
/** Env var that disables model-output capture in zero-config dev tracing. */
export const EVE_TRACE_RECORD_OUTPUTS_ENV = "EVE_TRACE_RECORD_OUTPUTS";

/**
 * Resolves a recording default from the environment. Capture is on unless the
 * var is explicitly set to `0` or `false`, so sensitive local data can be kept
 * off disk without authoring an `agent/instrumentation.ts`.
 */
export function recordDefaultFromEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/** Wiring for {@link registerLocalDevTracing}. */
export interface RegisterLocalDevTracingInput {
  /** Application root; traces are written under `<appRoot>/.eve/traces`. */
  readonly appRoot: string;
  /** Resolved agent name, used as `service.name` and the telemetry function id. */
  readonly agentName: string;
  readonly recordInputs?: boolean;
  readonly recordOutputs?: boolean;
  readonly maxTraces?: number;
}

/** Handle returned by {@link registerLocalDevTracing} for flushing and reads. */
export interface LocalDevTracingHandle {
  readonly store: TraceStore;
  /** Awaits all in-flight trace persistence. */
  flush(): Promise<void>;
}

let handle: LocalDevTracingHandle | undefined;
let processor: LocalSpanProcessor | undefined;

/**
 * Enables zero-config local trace capture for `eve dev`.
 *
 * Registers an eve-owned OpenTelemetry `TracerProvider` (with the local span
 * processor), an `AsyncLocalStorage` context manager so the turn span nests its
 * children, and a synthesized instrumentation config so the harness turns
 * telemetry on and stamps `eve.*` attributes — without the user authoring an
 * `agent/instrumentation.ts`. Idempotent, and best-effort: any failure is
 * logged and swallowed so tracing can never break `eve dev`.
 *
 * Only ever invoked from the development compiled-artifacts plugin, so it never
 * runs under `eve start`. Message-payload capture is on by default but can be
 * suppressed with `EVE_TRACE_RECORD_INPUTS=0` / `EVE_TRACE_RECORD_OUTPUTS=0`.
 */
export function registerLocalDevTracing(
  input: RegisterLocalDevTracingInput,
): LocalDevTracingHandle {
  if (handle !== undefined) return handle;

  const payload = {
    recordInputs: input.recordInputs ?? recordDefaultFromEnv(EVE_TRACE_RECORD_INPUTS_ENV),
    recordOutputs: input.recordOutputs ?? recordDefaultFromEnv(EVE_TRACE_RECORD_OUTPUTS_ENV),
  };
  const store = new TraceStore(input.appRoot, { maxTraces: input.maxTraces });

  try {
    const ringBuffer = new TraceRingBuffer({ maxTraces: input.maxTraces ?? 200 });
    processor = new LocalSpanProcessor({
      ringBuffer,
      store,
      payload,
      resourceAttributes: { "service.name": input.agentName },
    });
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    trace.setGlobalTracerProvider(provider);
    otelContext.setGlobalContextManager(new AlsContextManager());

    const config: InstrumentationDefinition = {
      functionId: input.agentName,
      recordInputs: payload.recordInputs,
      recordOutputs: payload.recordOutputs,
    };
    registerInstrumentationConfig(config, { agentName: input.agentName });
    log.debug("local dev tracing enabled", { appRoot: input.appRoot });
  } catch (error) {
    log.warn("failed to enable local dev tracing", { error: formatError(error) });
  }

  handle = {
    store,
    flush: async () => {
      await processor?.forceFlush();
    },
  };
  return handle;
}

/** Resets module state so a test can register a fresh provider. Test-only. */
export function resetLocalDevTracingForTesting(): void {
  handle = undefined;
  processor = undefined;
}
