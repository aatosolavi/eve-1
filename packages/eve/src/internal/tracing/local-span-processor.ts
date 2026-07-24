import type { ReadableSpan, SpanProcessor } from "#compiled/@opentelemetry/sdk-trace-base/index.js";
import {
  capturedSpanFromReadable,
  readEveAttribute,
  type CapturedAttributeValue,
  type CapturedSpan,
  type PayloadCaptureOptions,
} from "#internal/tracing/captured-span.js";
import { createLogger, formatError } from "#internal/logging.js";
import type { TraceRingBuffer } from "#internal/tracing/ring-buffer.js";

/** The span eve opens for a turn's first step; the root of the agent work. */
const TURN_SPAN_NAME = "ai.eve.turn";
const SESSION_SPAN_NAME = "ai.eve.session";

/** Durable sink a captured run is written to (satisfied by `TraceStore`). */
export interface TracePersister {
  write(
    runId: string,
    spans: readonly CapturedSpan[],
    resourceAttributes?: Readonly<Record<string, CapturedAttributeValue>>,
  ): Promise<void>;
}

/** Wiring for the local span processor. */
export interface LocalSpanProcessorInput {
  readonly ringBuffer: TraceRingBuffer;
  /** Optional durable sink; when omitted, capture is live-only (in-memory). */
  readonly store?: TracePersister;
  readonly payload: PayloadCaptureOptions;
  /** Resource attributes (e.g. `service.name`) attached to persisted OTLP. */
  readonly resourceAttributes?: Readonly<Record<string, CapturedAttributeValue>>;
}

/**
 * An OpenTelemetry {@link SpanProcessor} that captures the eve agent turn tree.
 *
 * eve registers a global tracer provider, so this receives every span in the
 * process — including the `@workflow/*` engine's own OTel spans. It persists
 * agent traces (rooted at `ai.eve.session`) under the **session id**, so a
 * session's turns and durable steps merge into one run — the local equivalent
 * of Vercel's Agent Runs. Traces with no agent work (a bare stream read or
 * hook resume, carrying no session id) are skipped, and overlapping writes
 * deduplicate by span id on read.
 *
 * All work is best-effort: a failure is logged and never propagated, so tracing
 * can never fail a turn.
 */
export class LocalSpanProcessor implements SpanProcessor {
  readonly #ringBuffer: TraceRingBuffer;
  readonly #store: TracePersister | undefined;
  readonly #payload: PayloadCaptureOptions;
  readonly #resourceAttributes: Readonly<Record<string, CapturedAttributeValue>>;
  readonly #pending = new Set<Promise<void>>();

  constructor(input: LocalSpanProcessorInput) {
    this.#ringBuffer = input.ringBuffer;
    this.#store = input.store;
    this.#payload = input.payload;
    this.#resourceAttributes = input.resourceAttributes ?? {};
  }

  onStart(): void {
    // No-op: capture happens on end, when timings and attributes are final.
  }

  onEnd(span: ReadableSpan): void {
    let captured: CapturedSpan;
    try {
      captured = capturedSpanFromReadable(span, this.#payload);
      this.#ringBuffer.add(captured);
    } catch (error) {
      log.warn("failed to capture span", { error: formatError(error) });
      return;
    }
    // Persist the whole trace so long as it contains agent work. We
    // (re)persist whenever a session span, turn span, an `invoke_agent` step
    // root, or the trace root ends — parents end after their
    // children, so the trace root end sees the full trace, while the turn/agent
    // triggers guarantee the agent spans are captured even across process
    // boundaries. Overlapping writes deduplicate by span id on read.
    if (this.#isCaptureTrigger(captured)) this.#persistTrace(captured);
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.#pending);
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }

  #isCaptureTrigger(span: CapturedSpan): boolean {
    return (
      span.name === SESSION_SPAN_NAME ||
      span.name === TURN_SPAN_NAME ||
      span.attributes["gen_ai.operation.name"] === "invoke_agent" ||
      span.parentSpanId === undefined
    );
  }

  #persistTrace(trigger: CapturedSpan): void {
    if (this.#store === undefined) return;
    const traceSpans = this.#ringBuffer.getTrace(trigger.traceId) ?? [trigger];
    // Key the run by session so a session's turns and steps merge into one run.
    // A trace with no session and no agent span is pure workflow plumbing (a
    // stream read, a hook resume) unrelated to any turn — skip it. A trace with
    // agent work but no attributed session falls back to its trace id.
    const runId =
      findSessionId(traceSpans) ?? (hasAgentWork(traceSpans) ? trigger.traceId : undefined);
    if (runId === undefined) return;
    // Order the triggering span first so the segment file name (its span id) is
    // stable per trigger — avoids clobbering another trigger's segment.
    const ordered = [trigger, ...traceSpans.filter((span) => span.spanId !== trigger.spanId)];
    const store = this.#store;
    const task = store
      .write(runId, ordered, this.#resourceAttributes)
      .catch((error: unknown) => {
        log.warn("failed to persist trace", { error: formatError(error), runId });
      })
      .finally(() => {
        this.#pending.delete(task);
      });
    this.#pending.add(task);
  }
}

const log = createLogger("tracing.processor");

/** The first session id found among a trace's spans (bare or AI-SDK-prefixed). */
function findSessionId(spans: readonly CapturedSpan[]): string | undefined {
  for (const span of spans) {
    const sessionId = readEveAttribute(span.attributes, "session.id");
    if (sessionId !== undefined) return sessionId;
  }
  return undefined;
}

/** Whether a trace contains any agent span (a turn or an AI SDK operation). */
function hasAgentWork(spans: readonly CapturedSpan[]): boolean {
  return spans.some(
    (span) =>
      span.name === SESSION_SPAN_NAME ||
      span.name === TURN_SPAN_NAME ||
      span.attributes["gen_ai.operation.name"] !== undefined,
  );
}
