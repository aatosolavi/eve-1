export interface SpanContext {
  spanId: string;
  traceFlags: number;
  traceId: string;
  traceState?: unknown;
}

export interface Span {
  addEvent(name: string, attributes?: Record<string, unknown>): this;
  end(): void;
  recordException(exception: unknown): void;
  setAttribute(key: string, value: unknown): this;
  setStatus(status: { code: SpanStatusCode; message?: string | undefined }): this;
  spanContext(): SpanContext;
}

export interface Tracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, unknown> | undefined },
    context?: Context,
  ): Span;
}

export interface Context {
  getValue(key: symbol): unknown;
  setValue(key: symbol, value: unknown): Context;
  deleteValue(key: symbol): Context;
}

export declare const ROOT_CONTEXT: Context;

export interface ContextManager {
  active(): Context;
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F>;
  bind<T>(context: Context, target: T): T;
  enable(): this;
  disable(): this;
}

export interface TracerProvider {
  getTracer(name: string, version?: string, options?: { schemaUrl?: string }): Tracer;
}

export declare enum SpanStatusCode {
  UNSET = 0,
  OK = 1,
  ERROR = 2,
}

export declare const context: {
  active(): Context;
  bind<T>(context: Context, target: T): T;
  setGlobalContextManager(contextManager: ContextManager): boolean;
  with<T>(context: Context, fn: () => T): T;
};

export declare const trace: {
  getActiveSpan(): Span | undefined;
  getTracer(name: string): Tracer;
  setSpan(context: Context, span: Span): Context;
  setGlobalTracerProvider(provider: TracerProvider): boolean;
  wrapSpanContext(spanContext: SpanContext): Span;
};

export declare enum SpanKind {
  INTERNAL = 0,
  SERVER = 1,
  CLIENT = 2,
  PRODUCER = 3,
  CONSUMER = 4,
}
