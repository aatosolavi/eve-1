// Hand-written subset of `@opentelemetry/sdk-trace-base`'s public surface —
// only the trace-capture primitives eve consumes. Kept minimal (like the
// sibling `@opentelemetry/api.d.ts` stub) to avoid dragging in the SDK's
// transitive `.d.ts` graph (`@opentelemetry/{core,resources}`).

import type { Tracer } from "#compiled/@opentelemetry/api/index.js";

export type HrTime = [number, number];

export type AttributeValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean | null | undefined>;

export type Attributes = Record<string, AttributeValue | undefined>;

export interface SpanStatus {
  code: number;
  message?: string;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: unknown;
}

export interface TimedEvent {
  time: HrTime;
  name: string;
  attributes?: Attributes;
}

/** The read-only view of a span handed to `SpanProcessor.onEnd`. */
export interface ReadableSpan {
  readonly name: string;
  readonly kind: number;
  readonly spanContext: () => SpanContext;
  readonly parentSpanContext?: SpanContext;
  readonly startTime: HrTime;
  readonly endTime: HrTime;
  readonly status: SpanStatus;
  readonly attributes: Attributes;
  readonly events: TimedEvent[];
  readonly duration: HrTime;
  readonly ended: boolean;
  readonly droppedAttributesCount: number;
  readonly droppedEventsCount: number;
  readonly droppedLinksCount: number;
}

export interface SpanProcessor {
  forceFlush(): Promise<void>;
  onStart(span: unknown, parentContext: unknown): void;
  onEnding?(span: unknown): void;
  onEnd(span: ReadableSpan): void;
  shutdown(): Promise<void>;
}

export interface ExportResult {
  code: number;
  error?: Error;
}

export interface SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

export interface TracerConfig {
  spanProcessors?: SpanProcessor[];
  resource?: unknown;
  sampler?: unknown;
}

export declare class BasicTracerProvider {
  constructor(config?: TracerConfig);
  getTracer(name: string, version?: string, options?: { schemaUrl?: string }): Tracer;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export declare class SimpleSpanProcessor implements SpanProcessor {
  constructor(exporter: SpanExporter);
  forceFlush(): Promise<void>;
  onStart(span: unknown, parentContext: unknown): void;
  onEnd(span: ReadableSpan): void;
  shutdown(): Promise<void>;
}

export declare class InMemorySpanExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
  getFinishedSpans(): ReadableSpan[];
  reset(): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

export declare class NoopSpanProcessor implements SpanProcessor {
  forceFlush(): Promise<void>;
  onStart(span: unknown, parentContext: unknown): void;
  onEnd(span: ReadableSpan): void;
  shutdown(): Promise<void>;
}
