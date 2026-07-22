/**
 * Local dev trace capture: an eve-owned OpenTelemetry pipeline that records the
 * span tree eve already emits (`ai.eve.turn` → `ai.streamText` → model/tool
 * spans) into an in-memory ring buffer and an on-disk OTLP/JSON store, for the
 * local trace viewer and `eve trace` CLI. Dev-only; never registered in
 * production.
 */
export {
  capturedSpanFromReadable,
  hrTimeToUnixNano,
  readEveAttribute,
  redactPayloadAttributes,
  unixNanoToMillis,
  type CapturedAttributeValue,
  type CapturedSpan,
  type PayloadCaptureOptions,
} from "#internal/tracing/captured-span.js";
export {
  capturedSpansToOtlp,
  otlpToCapturedSpans,
  type OtlpTracePayload,
} from "#internal/tracing/otlp.js";
export { TraceRingBuffer, type TraceSpanListener } from "#internal/tracing/ring-buffer.js";
export {
  projectRunSummary,
  projectWaterfall,
  type RunSummary,
  type WaterfallNode,
} from "#internal/tracing/projection.js";
export { TraceStore } from "#internal/tracing/trace-store.js";
export { AlsContextManager } from "#internal/tracing/als-context-manager.js";
export {
  LocalSpanProcessor,
  type LocalSpanProcessorInput,
  type TracePersister,
} from "#internal/tracing/local-span-processor.js";
