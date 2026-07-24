import type {
  GenerateTextEndEvent,
  GenerateTextStartEvent,
  InferTelemetryEvent,
  Telemetry,
} from "ai";

import { createLogger, formatError } from "#internal/logging.js";

type TelemetryEvent<TKey extends keyof Telemetry> = Parameters<NonNullable<Telemetry[TKey]>>[0];

/** Stable eve identity for one actual model attempt. */
export interface InstrumentationAttemptScope {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly functionId?: string;
  readonly sessionId: string;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface InstrumentationStepStartedEvent {
  readonly scope: InstrumentationAttemptScope;
  readonly operation: InferTelemetryEvent<GenerateTextStartEvent>;
  readonly step: TelemetryEvent<"onStepStart">;
}

export interface InstrumentationStepCompletedEvent {
  readonly scope: InstrumentationAttemptScope;
  readonly operation: InferTelemetryEvent<GenerateTextStartEvent>;
  readonly result: InferTelemetryEvent<GenerateTextEndEvent>;
  readonly step: TelemetryEvent<"onStepEnd"> | undefined;
}

export interface InstrumentationStepFailedEvent {
  readonly error: unknown;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationModelCallStartedEvent {
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
  readonly source: TelemetryEvent<"onLanguageModelCallStart">;
}

export interface InstrumentationModelCallCompletedEvent {
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
  readonly source: TelemetryEvent<"onLanguageModelCallEnd">;
}

export interface InstrumentationToolCallStartedEvent {
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
  readonly source: TelemetryEvent<"onToolExecutionStart">;
}

export interface InstrumentationToolCallCompletedEvent {
  readonly id: string;
  readonly scope: InstrumentationAttemptScope;
  readonly source: TelemetryEvent<"onToolExecutionEnd">;
}

export interface RelatedLifecycleHook<TStart, TTerminal> {
  readonly before?: (event: TStart) => unknown | PromiseLike<unknown>;
  readonly after?: (event: TTerminal, state: unknown) => void | PromiseLike<void>;
}

/** Internal provider shape mirrored by the future public hook contract. */
export interface InstrumentationProviderDefinition {
  readonly events?: {
    readonly "model.call"?: RelatedLifecycleHook<
      InstrumentationModelCallStartedEvent,
      InstrumentationModelCallCompletedEvent
    >;
    readonly "step.completed"?: (
      event: InstrumentationStepCompletedEvent,
    ) => void | PromiseLike<void>;
    readonly "step.failed"?: (event: InstrumentationStepFailedEvent) => void | PromiseLike<void>;
    readonly "step.started"?: (event: InstrumentationStepStartedEvent) => void | PromiseLike<void>;
    readonly "tool.call"?: RelatedLifecycleHook<
      InstrumentationToolCallStartedEvent,
      InstrumentationToolCallCompletedEvent
    >;
  };
  readonly executionContext?: {
    runModelCall<T>(id: string, execute: () => PromiseLike<T>): PromiseLike<T>;
    runToolCall<T>(id: string, execute: () => PromiseLike<T>): PromiseLike<T>;
  };
}

const log = createLogger("harness.instrumentation-lifecycle");

/** Failure-isolated lifecycle dispatcher shared by all instrumentation providers. */
export class InstrumentationLifecyclePublisher {
  readonly #providers: readonly InstrumentationProviderDefinition[];
  readonly #relatedState = new Map<string, Map<InstrumentationProviderDefinition, unknown>>();

  constructor(providers: readonly InstrumentationProviderDefinition[]) {
    this.#providers = providers;
  }

  async publishStepStarted(event: InstrumentationStepStartedEvent): Promise<void> {
    await this.#publishPoint("step.started", event);
  }

  async publishStepCompleted(event: InstrumentationStepCompletedEvent): Promise<void> {
    await this.#publishPoint("step.completed", event);
  }

  async publishStepFailed(event: InstrumentationStepFailedEvent): Promise<void> {
    await this.#publishPoint("step.failed", event);
  }

  async beforeModelCall(event: InstrumentationModelCallStartedEvent): Promise<void> {
    await this.#before("model.call", event.id, event);
  }

  async afterModelCall(event: InstrumentationModelCallCompletedEvent): Promise<void> {
    await this.#after("model.call", event.id, event);
  }

  async beforeToolCall(event: InstrumentationToolCallStartedEvent): Promise<void> {
    await this.#before("tool.call", event.id, event);
  }

  async afterToolCall(event: InstrumentationToolCallCompletedEvent): Promise<void> {
    await this.#after("tool.call", event.id, event);
  }

  runModelCall<T>(id: string, execute: () => PromiseLike<T>): PromiseLike<T> {
    return this.#runWithAdapters("runModelCall", id, execute);
  }

  runToolCall<T>(id: string, execute: () => PromiseLike<T>): PromiseLike<T> {
    return this.#runWithAdapters("runToolCall", id, execute);
  }

  async #publishPoint(
    key: "step.started" | "step.completed" | "step.failed",
    event:
      | InstrumentationStepStartedEvent
      | InstrumentationStepCompletedEvent
      | InstrumentationStepFailedEvent,
  ): Promise<void> {
    for (const provider of this.#providers) {
      const handler = provider.events?.[key];
      if (handler === undefined) continue;
      try {
        await (handler as (value: typeof event) => void | PromiseLike<void>)(event);
      } catch (error) {
        this.#warn(key, error);
      }
    }
  }

  async #before(
    key: "model.call" | "tool.call",
    id: string,
    event: InstrumentationModelCallStartedEvent | InstrumentationToolCallStartedEvent,
  ): Promise<void> {
    const stateByProvider = new Map<InstrumentationProviderDefinition, unknown>();
    this.#relatedState.set(id, stateByProvider);
    for (const provider of this.#providers) {
      const handler = provider.events?.[key]?.before;
      if (handler === undefined) continue;
      try {
        const state = await (handler as (value: typeof event) => unknown)(event);
        stateByProvider.set(provider, state);
      } catch (error) {
        this.#warn(`${key}.before`, error);
      }
    }
  }

  async #after(
    key: "model.call" | "tool.call",
    id: string,
    event: InstrumentationModelCallCompletedEvent | InstrumentationToolCallCompletedEvent,
  ): Promise<void> {
    const stateByProvider = this.#relatedState.get(id);
    this.#relatedState.delete(id);
    for (const provider of this.#providers) {
      const handler = provider.events?.[key]?.after;
      if (handler === undefined || !stateByProvider?.has(provider)) continue;
      try {
        await (handler as (value: typeof event, state: unknown) => void | PromiseLike<void>)(
          event,
          stateByProvider.get(provider),
        );
      } catch (error) {
        this.#warn(`${key}.after`, error);
      }
    }
  }

  #runWithAdapters<T>(
    key: "runModelCall" | "runToolCall",
    id: string,
    execute: () => PromiseLike<T>,
  ): PromiseLike<T> {
    let run = execute;
    for (const provider of [...this.#providers].reverse()) {
      const adapter = provider.executionContext;
      if (adapter === undefined) continue;
      const next = run;
      run = () =>
        key === "runModelCall" ? adapter.runModelCall(id, next) : adapter.runToolCall(id, next);
    }
    return run();
  }

  #warn(boundary: string, error: unknown): void {
    log.warn("instrumentation provider failed", { boundary, error: formatError(error) });
  }
}
