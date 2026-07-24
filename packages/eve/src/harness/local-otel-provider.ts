import {
  ROOT_CONTEXT,
  type Context,
  type Span,
  type Tracer,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationModelCallCompletedEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationProviderDefinition,
  InstrumentationStepCompletedEvent,
  InstrumentationStepFailedEvent,
  InstrumentationStepStartedEvent,
  InstrumentationToolCallCompletedEvent,
  InstrumentationToolCallStartedEvent,
} from "#harness/instrumentation-lifecycle.js";
import type { TraceStore } from "#internal/tracing/trace-store.js";
import { AlsContextManager } from "#internal/tracing/als-context-manager.js";

interface SpanState {
  readonly context: Context;
  readonly span: Span;
}

interface AttemptState extends SpanState {
  readonly sessionSpan?: Span;
  readonly turnSpan?: Span;
}

export interface LocalOtelProviderInput {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly store: TraceStore;
  readonly tracer: Tracer;
}

/** Creates the local OTel hook provider used by the provider-neutral bridge. */
export function createLocalOtelProvider(
  input: LocalOtelProviderInput,
): InstrumentationProviderDefinition {
  const attempts = new Map<string, AttemptState>();
  const contextManager = new AlsContextManager();
  const modelCalls = new Map<string, SpanState>();
  const sessions = new Map<string, Context>();
  const toolCalls = new Map<string, SpanState>();
  const turns = new Map<string, Context>();

  const startStep = async (event: InstrumentationStepStartedEvent): Promise<void> => {
    const session = await resolveSessionContext(event);
    const turn = await resolveTurnContext(event, session.context);
    const attributes: Record<string, unknown> = {
      "gen_ai.agent.name": event.scope.functionId,
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": normalizeProviderName(event.operation.provider),
      "gen_ai.request.model": event.operation.modelId,
      "eve.session.id": event.scope.sessionId,
      "eve.step.index": String(event.scope.stepIndex),
      "eve.turn.id": event.scope.turnId,
    };
    if (input.recordInputs) {
      attributes["gen_ai.input.messages"] = safeJson(event.operation.messages);
      attributes["gen_ai.system_instructions"] = safeJson(event.operation.instructions);
    }
    flattenRuntimeContext(attributes, event.operation.runtimeContext);
    const span = input.tracer.startSpan(
      `invoke_agent ${event.operation.modelId}`,
      { attributes },
      turn.context,
    );
    attempts.set(event.scope.attemptId, {
      context: trace.setSpan(turn.context, span),
      sessionSpan: session.span,
      span,
      turnSpan: turn.span,
    });
  };

  const finishStep = (event: InstrumentationStepCompletedEvent): void => {
    const state = attempts.get(event.scope.attemptId);
    if (state === undefined) return;
    const usage = event.result.usage;
    setUsage(state.span, usage);
    state.span.setAttribute("gen_ai.response.finish_reasons", [event.result.finishReason]);
    if (input.recordOutputs) {
      setJsonAttribute(state.span, "gen_ai.output.messages", event.result.content);
    }
    finishAttempt(event.scope.attemptId, state);
  };

  const failStep = (event: InstrumentationStepFailedEvent): void => {
    const state = attempts.get(event.scope.attemptId);
    if (state === undefined) return;
    for (const [id, operation] of modelCalls) {
      if (!id.startsWith(`${event.scope.attemptId}:`)) continue;
      recordError(operation.span, event.error);
      operation.span.end();
      modelCalls.delete(id);
    }
    for (const [id, operation] of toolCalls) {
      if (!id.startsWith(`${event.scope.attemptId}:`)) continue;
      recordError(operation.span, event.error);
      operation.span.end();
      toolCalls.delete(id);
    }
    recordError(state.span, event.error);
    finishAttempt(event.scope.attemptId, state);
  };

  const beforeModelCall = (event: InstrumentationModelCallStartedEvent): SpanState | undefined => {
    const attempt = attempts.get(event.scope.attemptId);
    if (attempt === undefined) return undefined;
    const attributes: Record<string, unknown> = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": normalizeProviderName(event.source.provider),
      "gen_ai.request.model": event.source.modelId,
    };
    if (input.recordInputs) {
      attributes["gen_ai.input.messages"] = safeJson(event.source.messages);
      attributes["gen_ai.tool.definitions"] = safeJson(event.source.tools);
    }
    const span = input.tracer.startSpan(
      `chat ${event.source.modelId}`,
      { attributes },
      attempt.context,
    );
    const state = { context: trace.setSpan(attempt.context, span), span };
    modelCalls.set(event.id, state);
    return state;
  };

  const afterModelCall = (event: InstrumentationModelCallCompletedEvent, value: unknown): void => {
    const state = isSpanState(value) ? value : modelCalls.get(event.id);
    modelCalls.delete(event.id);
    if (state === undefined) return;
    state.span.setAttribute("gen_ai.response.finish_reasons", [event.source.finishReason]);
    state.span.setAttribute("gen_ai.response.id", event.source.responseId);
    state.span.setAttribute(
      "gen_ai.client.operation.duration",
      event.source.performance.responseTimeMs / 1_000,
    );
    setUsage(state.span, event.source.usage);
    if (input.recordOutputs) {
      setJsonAttribute(state.span, "gen_ai.output.messages", event.source.content);
    }
    state.span.end();
  };

  const beforeToolCall = (event: InstrumentationToolCallStartedEvent): SpanState | undefined => {
    const attempt = attempts.get(event.scope.attemptId);
    if (attempt === undefined) return undefined;
    const attributes: Record<string, unknown> = {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.call.id": event.source.toolCall.toolCallId,
      "gen_ai.tool.name": event.source.toolCall.toolName,
      "gen_ai.tool.type": "function",
    };
    if (input.recordInputs) {
      attributes["gen_ai.tool.call.arguments"] = safeJson(event.source.toolCall.input);
    }
    const span = input.tracer.startSpan(
      `execute_tool ${event.source.toolCall.toolName}`,
      { attributes },
      attempt.context,
    );
    const state = { context: trace.setSpan(attempt.context, span), span };
    toolCalls.set(event.id, state);
    return state;
  };

  const afterToolCall = (event: InstrumentationToolCallCompletedEvent, value: unknown): void => {
    const state = isSpanState(value) ? value : toolCalls.get(event.id);
    toolCalls.delete(event.id);
    if (state === undefined) return;
    state.span.setAttribute("gen_ai.execute_tool.duration", event.source.toolExecutionMs / 1_000);
    if (event.source.toolOutput.type === "tool-result") {
      if (input.recordOutputs) {
        setJsonAttribute(state.span, "gen_ai.tool.call.result", event.source.toolOutput.output);
      }
    } else {
      recordError(state.span, event.source.toolOutput.error);
    }
    state.span.end();
  };

  const resolveSessionContext = async (
    event: InstrumentationStepStartedEvent,
  ): Promise<{ context: Context; span?: Span }> => {
    const existing = sessions.get(event.scope.sessionId);
    if (existing !== undefined) return { context: existing };
    const stored = await findStoredSpan(event.scope.sessionId, "ai.eve.session");
    if (stored !== undefined) {
      const context = contextFromStored(stored.traceId, stored.spanId);
      sessions.set(event.scope.sessionId, context);
      return { context };
    }
    const span = input.tracer.startSpan(
      "ai.eve.session",
      { attributes: { "eve.session.id": event.scope.sessionId } },
      ROOT_CONTEXT,
    );
    const context = trace.setSpan(ROOT_CONTEXT, span);
    sessions.set(event.scope.sessionId, context);
    return { context, span };
  };

  const resolveTurnContext = async (
    event: InstrumentationStepStartedEvent,
    parent: Context,
  ): Promise<{ context: Context; span?: Span }> => {
    const key = `${event.scope.sessionId}:${event.scope.turnId}`;
    const existing = turns.get(key);
    if (existing !== undefined) return { context: existing };
    const stored = await findStoredSpan(event.scope.sessionId, "ai.eve.turn", event.scope.turnId);
    if (stored !== undefined) {
      const context = contextFromStored(stored.traceId, stored.spanId);
      turns.set(key, context);
      return { context };
    }
    const span = input.tracer.startSpan(
      "ai.eve.turn",
      {
        attributes: {
          "eve.session.id": event.scope.sessionId,
          "eve.turn.id": event.scope.turnId,
        },
      },
      parent,
    );
    const context = trace.setSpan(parent, span);
    turns.set(key, context);
    return { context, span };
  };

  const findStoredSpan = async (sessionId: string, name: string, turnId?: string) => {
    const spans = await input.store.read(sessionId);
    return spans?.find(
      (span) =>
        span.name === name && (turnId === undefined || span.attributes["eve.turn.id"] === turnId),
    );
  };

  const finishAttempt = (attemptId: string, state: AttemptState): void => {
    attempts.delete(attemptId);
    state.span.end();
    state.turnSpan?.end();
    state.sessionSpan?.end();
  };

  return {
    events: {
      "model.call": { after: afterModelCall, before: beforeModelCall },
      "step.completed": finishStep,
      "step.failed": failStep,
      "step.started": startStep,
      "tool.call": { after: afterToolCall, before: beforeToolCall },
    },
    executionContext: {
      runModelCall(id, execute) {
        return runWithState(contextManager, modelCalls.get(id), execute);
      },
      runToolCall(id, execute) {
        return runWithState(contextManager, toolCalls.get(id), execute);
      },
    },
  };
}

function contextFromStored(traceId: string, spanId: string): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext({ spanId, traceFlags: 1, traceId }));
}

function runWithState<T>(
  contextManager: AlsContextManager,
  state: SpanState | undefined,
  execute: () => PromiseLike<T>,
): PromiseLike<T> {
  return state === undefined ? execute() : contextManager.with(state.context, execute);
}

function isSpanState(value: unknown): value is SpanState {
  return typeof value === "object" && value !== null && "span" in value && "context" in value;
}

function normalizeProviderName(provider: string): string {
  const lower = provider.toLowerCase();
  if (lower.startsWith("anthropic")) return "anthropic";
  if (lower.startsWith("openai")) return "openai";
  if (lower.startsWith("google")) return "gcp.gemini";
  return provider;
}

function safeJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function setJsonAttribute(span: Span, key: string, value: unknown): void {
  const json = safeJson(value);
  if (json !== undefined) span.setAttribute(key, json);
}

function setUsage(
  span: Span,
  usage: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly inputTokenDetails?: {
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    };
  },
): void {
  if (usage.inputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
  }
  if (usage.outputTokens !== undefined) {
    span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
  }
  if (usage.inputTokenDetails?.cacheReadTokens !== undefined) {
    span.setAttribute(
      "gen_ai.usage.cache_read.input_tokens",
      usage.inputTokenDetails.cacheReadTokens,
    );
  }
  if (usage.inputTokenDetails?.cacheWriteTokens !== undefined) {
    span.setAttribute(
      "gen_ai.usage.cache_creation.input_tokens",
      usage.inputTokenDetails.cacheWriteTokens,
    );
  }
}

function flattenRuntimeContext(
  attributes: Record<string, unknown>,
  value: unknown,
  prefix = "ai.settings.context",
): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    attributes[prefix] = value;
    return;
  }
  if (Array.isArray(value)) {
    const primitive = value.filter(
      (entry): entry is string | number | boolean =>
        typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
    );
    if (
      primitive.length === value.length &&
      new Set(primitive.map((entry) => typeof entry)).size === 1
    ) {
      attributes[prefix] = primitive;
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    flattenRuntimeContext(attributes, entry, `${prefix}.${key}`);
  }
}

function recordError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: 2, message: error.message });
  } else {
    span.setStatus({ code: 2 });
  }
}
