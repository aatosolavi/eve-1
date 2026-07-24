import type { Telemetry } from "ai";

import {
  context as otelContext,
  type Context,
  type Span,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

type TelemetryEvent<TKey extends keyof Telemetry> = Parameters<NonNullable<Telemetry[TKey]>>[0];

/**
 * An eve-owned AI SDK `Telemetry` implementation that emits GenAI semantic
 * convention spans directly, replacing `@ai-sdk/otel`'s `OpenTelemetry`.
 *
 * Span hierarchy (no intermediate `step {n}` wrapper):
 *
 * ```
 * invoke_agent {modelId}     — onStart / onEnd
 *   ├── chat {modelId}        — onLanguageModelCallStart / onLanguageModelCallEnd
 *   └── execute_tool {name}   — onToolExecutionStart / onToolExecutionEnd
 * ```
 *
 * `executeLanguageModelCall` and `executeTool` activate the appropriate span
 * context so provider requests and nested tool calls nest correctly.
 *
 * Uses the same `"eve"` tracer as the session/turn spans so the entire trace
 * tree shares one traceId.
 */

interface CallState {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly rootSpan: Span;
  readonly rootContext: Context;
  inferenceSpan: Span | undefined;
  inferenceContext: Context | undefined;
  readonly toolSpans: Map<string, { readonly span: Span; readonly context: Context }>;
}

function read(event: unknown, key: string): unknown {
  if (typeof event === "object" && event !== null) {
    return (event as Record<string, unknown>)[key];
  }
  return undefined;
}

function readString(event: unknown, key: string): string | undefined {
  const value = read(event, key);
  return typeof value === "string" ? value : undefined;
}

function readNumber(event: unknown, key: string): number | undefined {
  const value = read(event, key);
  return typeof value === "number" ? value : undefined;
}

function readBoolean(event: unknown, key: string): boolean | undefined {
  const value = read(event, key);
  return typeof value === "boolean" ? value : undefined;
}

function readArray(event: unknown, key: string): readonly unknown[] | undefined {
  const value = read(event, key);
  return Array.isArray(value) ? value : undefined;
}

function readObject(event: unknown, key: string): Record<string, unknown> | undefined {
  const value = read(event, key);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function setAttributes(span: Span, attrs: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) {
      span.setAttribute(key, value);
    }
  }
}

function recordError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException({ name: error.name, message: error.message, stack: error.stack });
    span.setStatus({ code: 2, message: error.message });
  } else {
    span.setStatus({ code: 2 });
  }
}

function normalizeProviderName(provider: string): string {
  const lower = provider.toLowerCase();
  const known: ReadonlyArray<readonly [string, string]> = [
    ["google.vertex", "gcp.vertex_ai"],
    ["google.generative-ai", "gcp.gemini"],
    ["google-vertex", "gcp.vertex_ai"],
    ["amazon-bedrock", "aws.bedrock"],
    ["azure-openai", "azure.ai.openai"],
    ["anthropic", "anthropic"],
    ["openai", "openai"],
    ["azure", "azure.ai.inference"],
    ["google", "gcp.gemini"],
    ["mistral", "mistral_ai"],
    ["cohere", "cohere"],
    ["bedrock", "aws.bedrock"],
    ["groq", "groq"],
    ["deepseek", "deepseek"],
    ["perplexity", "perplexity"],
    ["xai", "x_ai"],
  ];
  for (const [match, normalized] of known) {
    if (lower === match || lower.startsWith(`${match}.`) || lower.startsWith(`${match}-`)) {
      return normalized;
    }
  }
  return provider;
}

class EveOtelBridge implements Telemetry {
  readonly #tracer = trace.getTracer("eve");
  readonly #callStates = new Map<string, CallState>();

  #getCallState(callId: string): CallState | undefined {
    return this.#callStates.get(callId);
  }

  #cleanupCallState(callId: string): void {
    this.#callStates.delete(callId);
  }

  executeLanguageModelCall<T>(options: {
    callId: string;
    execute: () => PromiseLike<T>;
  }): PromiseLike<T> {
    const state = this.#getCallState(options.callId);
    const ctx = state?.inferenceContext;
    if (ctx === undefined) return options.execute();
    return otelContext.with(ctx, options.execute);
  }

  executeTool<T>(options: {
    callId: string;
    toolCallId: string;
    execute: () => PromiseLike<T>;
  }): PromiseLike<T> {
    const state = this.#getCallState(options.callId);
    const toolState = state?.toolSpans.get(options.toolCallId);
    if (toolState === undefined) return options.execute();
    return otelContext.with(toolState.context, options.execute);
  }

  onStart(event: TelemetryEvent<"onStart">): void {
    const callId = readString(event, "callId");
    if (callId === undefined) return;
    const operationId = readString(event, "operationId") ?? "ai.streamText";
    const provider = readString(event, "provider") ?? "unknown";
    const modelId = readString(event, "modelId") ?? "unknown";
    const recordInputs = readBoolean(event, "recordInputs") ?? true;
    const recordOutputs = readBoolean(event, "recordOutputs") ?? true;
    const functionId = readString(event, "functionId");

    const providerName = normalizeProviderName(provider);
    const spanName =
      operationId === "ai.streamText" || operationId === "ai.generateText"
        ? `invoke_agent ${modelId}`
        : `${operationId} ${modelId}`;

    const attributes: Record<string, unknown> = {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": providerName,
      "gen_ai.request.model": modelId,
    };

    if (functionId !== undefined) {
      attributes["gen_ai.agent.name"] = functionId;
    }

    // Stamp eve.* runtime context attributes so the LocalSpanProcessor can
    // group spans by session id. The AI SDK passes these via the
    // runtimeContext field on the telemetry event.
    const runtimeContext = readObject(event, "runtimeContext");
    if (runtimeContext !== undefined) {
      for (const [key, value] of Object.entries(runtimeContext)) {
        if (value !== undefined && value !== null) {
          attributes[`ai.settings.context.${key}`] = value;
        }
      }
    }

    const temp = readNumber(event, "temperature");
    if (temp !== undefined) attributes["gen_ai.request.temperature"] = temp;
    const maxTokens = readNumber(event, "maxOutputTokens");
    if (maxTokens !== undefined) attributes["gen_ai.request.max_tokens"] = maxTokens;
    const topP = readNumber(event, "topP");
    if (topP !== undefined) attributes["gen_ai.request.top_p"] = topP;
    const topK = readNumber(event, "topK");
    if (topK !== undefined) attributes["gen_ai.request.top_k"] = topK;
    const presencePenalty = readNumber(event, "presencePenalty");
    if (presencePenalty !== undefined)
      attributes["gen_ai.request.presence_penalty"] = presencePenalty;
    const frequencyPenalty = readNumber(event, "frequencyPenalty");
    if (frequencyPenalty !== undefined)
      attributes["gen_ai.request.frequency_penalty"] = frequencyPenalty;
    const stopSequences = readArray(event, "stopSequences");
    if (stopSequences !== undefined) attributes["gen_ai.request.stop_sequences"] = stopSequences;
    const seed = readNumber(event, "seed");
    if (seed !== undefined) attributes["gen_ai.request.seed"] = seed;

    if (recordInputs) {
      const instructions = read(event, "instructions");
      if (instructions !== undefined) {
        const json = safeJson(instructions);
        if (json !== undefined) attributes["gen_ai.system_instructions"] = json;
      }
      const messages = readArray(event, "messages");
      if (messages !== undefined) {
        const json = safeJson(messages);
        if (json !== undefined) attributes["gen_ai.input.messages"] = json;
      }
    }

    const rootSpan = this.#tracer.startSpan(spanName, { attributes });
    const rootContext = trace.setSpan(otelContext.active(), rootSpan);

    this.#callStates.set(callId, {
      recordInputs,
      recordOutputs,
      rootSpan,
      rootContext,
      inferenceSpan: undefined,
      inferenceContext: undefined,
      toolSpans: new Map(),
    });
  }

  onStepStart(_event: TelemetryEvent<"onStepStart">): void {
    // Intentionally a no-op — eve's bridge does not create the intermediate
    // `step {n}` span. Chat and tool spans nest directly under invoke_agent.
  }

  onStepEnd(_event: TelemetryEvent<"onStepEnd">): void {
    // No-op — see onStepStart.
  }

  onStepFinish(_event: TelemetryEvent<"onStepFinish">): void {
    // Deprecated alias for onStepEnd.
  }

  onLanguageModelCallStart(event: TelemetryEvent<"onLanguageModelCallStart">): void {
    const callId = readString(event, "callId");
    if (callId === undefined) return;
    const state = this.#getCallState(callId);
    if (state === undefined) return;

    const provider = readString(event, "provider") ?? "unknown";
    const modelId = readString(event, "modelId") ?? "unknown";
    const providerName = normalizeProviderName(provider);
    const spanName = `chat ${modelId}`;

    const attributes: Record<string, unknown> = {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": providerName,
      "gen_ai.request.model": modelId,
    };

    const temp = readNumber(event, "temperature");
    if (temp !== undefined) attributes["gen_ai.request.temperature"] = temp;
    const maxTokens = readNumber(event, "maxOutputTokens");
    if (maxTokens !== undefined) attributes["gen_ai.request.max_tokens"] = maxTokens;
    const topP = readNumber(event, "topP");
    if (topP !== undefined) attributes["gen_ai.request.top_p"] = topP;
    const topK = readNumber(event, "topK");
    if (topK !== undefined) attributes["gen_ai.request.top_k"] = topK;
    const presencePenalty = readNumber(event, "presencePenalty");
    if (presencePenalty !== undefined)
      attributes["gen_ai.request.presence_penalty"] = presencePenalty;
    const frequencyPenalty = readNumber(event, "frequencyPenalty");
    if (frequencyPenalty !== undefined)
      attributes["gen_ai.request.frequency_penalty"] = frequencyPenalty;
    const stopSequences = readArray(event, "stopSequences");
    if (stopSequences !== undefined) attributes["gen_ai.request.stop_sequences"] = stopSequences;

    if (state.recordInputs) {
      const messages = readArray(event, "messages");
      if (messages !== undefined) {
        const json = safeJson(messages);
        if (json !== undefined) attributes["gen_ai.input.messages"] = json;
      }
      const tools = readArray(event, "tools");
      if (tools !== undefined) {
        const json = safeJson(tools);
        if (json !== undefined) attributes["gen_ai.tool.definitions"] = json;
      }
    }

    // startSpan only takes 2 args; use context.with to set the parent.
    let span: Span | undefined;
    otelContext.with(state.rootContext, () => {
      span = this.#tracer.startSpan(spanName, { attributes });
    });
    if (span === undefined) return;
    state.inferenceSpan = span;
    state.inferenceContext = trace.setSpan(state.rootContext, span);
  }

  onLanguageModelCallEnd(event: TelemetryEvent<"onLanguageModelCallEnd">): void {
    const callId = readString(event, "callId");
    if (callId === undefined) return;
    const state = this.#getCallState(callId);
    if (state?.inferenceSpan === undefined) return;

    const { inferenceSpan, recordOutputs } = state;

    const attributes: Record<string, unknown> = {
      "gen_ai.response.finish_reasons": [readString(event, "finishReason") ?? "stop"],
    };

    const responseId = readString(event, "responseId");
    if (responseId !== undefined) attributes["gen_ai.response.id"] = responseId;

    const usage = readObject(event, "usage");
    if (usage !== undefined) {
      const inputTokens = readNumber(usage, "inputTokens");
      if (inputTokens !== undefined) attributes["gen_ai.usage.input_tokens"] = inputTokens;
      const outputTokens = readNumber(usage, "outputTokens");
      if (outputTokens !== undefined) attributes["gen_ai.usage.output_tokens"] = outputTokens;
      const tokenDetails = readObject(usage, "inputTokenDetails");
      if (tokenDetails !== undefined) {
        const cacheRead = readNumber(tokenDetails, "cacheReadTokens");
        if (cacheRead !== undefined) attributes["gen_ai.usage.cache_read.input_tokens"] = cacheRead;
        const cacheWrite = readNumber(tokenDetails, "cacheWriteTokens");
        if (cacheWrite !== undefined)
          attributes["gen_ai.usage.cache_creation.input_tokens"] = cacheWrite;
      }
    }

    const performance = readObject(event, "performance");
    if (performance !== undefined) {
      const responseTimeMs = readNumber(performance, "responseTimeMs");
      if (responseTimeMs !== undefined)
        attributes["gen_ai.client.operation.duration"] = responseTimeMs / 1000;
      const timeToFirst = readNumber(performance, "timeToFirstOutputMs");
      if (timeToFirst !== undefined)
        attributes["gen_ai.client.operation.time_to_first_chunk"] = timeToFirst / 1000;
    }

    if (recordOutputs) {
      const content = readArray(event, "content");
      if (content !== undefined) {
        const json = safeJson(content);
        if (json !== undefined) attributes["gen_ai.output.messages"] = json;
      }
    }

    setAttributes(inferenceSpan, attributes);
    inferenceSpan.end();
    state.inferenceSpan = undefined;
    state.inferenceContext = undefined;
  }

  onToolExecutionStart(event: TelemetryEvent<"onToolExecutionStart">): void {
    const callId = readString(event, "callId");
    if (callId === undefined) return;
    const state = this.#getCallState(callId);
    if (state === undefined) return;

    const toolCall = readObject(event, "toolCall");
    if (toolCall === undefined) return;
    const toolName = readString(toolCall, "toolName") ?? "unknown";
    const toolCallId = readString(toolCall, "toolCallId") ?? "";
    const spanName = `execute_tool ${toolName}`;

    const attributes: Record<string, unknown> = {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": toolName,
      "gen_ai.tool.call.id": toolCallId,
      "gen_ai.tool.type": "function",
    };

    if (state.recordInputs) {
      const input = read(toolCall, "input");
      if (input !== undefined) {
        const json = safeJson(input);
        if (json !== undefined) attributes["gen_ai.tool.call.arguments"] = json;
      }
    }

    let span: Span | undefined;
    otelContext.with(state.rootContext, () => {
      span = this.#tracer.startSpan(spanName, { attributes });
    });
    if (span === undefined) return;
    const ctx = trace.setSpan(state.rootContext, span);
    state.toolSpans.set(toolCallId, { span, context: ctx });
  }

  onToolExecutionEnd(event: TelemetryEvent<"onToolExecutionEnd">): void {
    const callId = readString(event, "callId");
    if (callId === undefined) return;
    const state = this.#getCallState(callId);
    if (state === undefined) return;

    const toolCall = readObject(event, "toolCall");
    const toolCallId = toolCall !== undefined ? readString(toolCall, "toolCallId") : undefined;
    if (toolCallId === undefined) return;

    const toolState = state.toolSpans.get(toolCallId);
    if (toolState === undefined) return;

    const { span } = toolState;

    const durationMs = readNumber(event, "toolExecutionMs");
    if (durationMs !== undefined) {
      span.setAttribute("gen_ai.execute_tool.duration", durationMs / 1000);
    }

    const success = readBoolean(event, "success") ?? true;
    if (success && state.recordOutputs) {
      const output = read(event, "output");
      if (output !== undefined) {
        const json = safeJson(output);
        if (json !== undefined) span.setAttribute("gen_ai.tool.call.result", json);
      }
    } else if (!success) {
      recordError(span, read(event, "error"));
    }

    span.end();
    state.toolSpans.delete(toolCallId);
  }

  onEnd(event: TelemetryEvent<"onEnd">): void {
    const callId = readString(event, "callId");
    if (callId === undefined) return;
    const state = this.#getCallState(callId);
    if (state === undefined) return;

    const { rootSpan } = state;

    const attributes: Record<string, unknown> = {};

    const finishReason = readString(event, "finishReason");
    if (finishReason !== undefined) {
      attributes["gen_ai.response.finish_reasons"] = [finishReason];
    }

    const usage = readObject(event, "usage");
    if (usage !== undefined) {
      const inputTokens = readNumber(usage, "inputTokens");
      if (inputTokens !== undefined) attributes["gen_ai.usage.input_tokens"] = inputTokens;
      const outputTokens = readNumber(usage, "outputTokens");
      if (outputTokens !== undefined) attributes["gen_ai.usage.output_tokens"] = outputTokens;
      const tokenDetails = readObject(usage, "inputTokenDetails");
      if (tokenDetails !== undefined) {
        const cacheRead = readNumber(tokenDetails, "cacheReadTokens");
        if (cacheRead !== undefined) attributes["gen_ai.usage.cache_read.input_tokens"] = cacheRead;
        const cacheWrite = readNumber(tokenDetails, "cacheWriteTokens");
        if (cacheWrite !== undefined)
          attributes["gen_ai.usage.cache_creation.input_tokens"] = cacheWrite;
      }
    }

    setAttributes(rootSpan, attributes);
    rootSpan.end();
    this.#cleanupCallState(callId);
  }

  onAbort(event: TelemetryEvent<"onAbort">): void {
    const callId = readString(event, "callId");
    if (callId === undefined) return;
    const state = this.#getCallState(callId);
    if (state === undefined) return;

    for (const { span } of state.toolSpans.values()) span.end();
    state.toolSpans.clear();
    state.inferenceSpan?.end();
    state.inferenceSpan = undefined;
    state.inferenceContext = undefined;
    state.rootSpan.end();
    this.#cleanupCallState(callId);
  }

  onError(error: unknown): void {
    const errorEvent = error as Record<string, unknown> | undefined;
    const callId = typeof errorEvent?.callId === "string" ? errorEvent.callId : undefined;
    if (callId === undefined) return;

    const state = this.#getCallState(callId);
    if (state === undefined) return;

    const err = errorEvent?.error ?? error;
    for (const { span } of state.toolSpans.values()) {
      recordError(span, err);
      span.end();
    }
    state.toolSpans.clear();
    if (state.inferenceSpan !== undefined) {
      recordError(state.inferenceSpan, err);
      state.inferenceSpan.end();
      state.inferenceSpan = undefined;
      state.inferenceContext = undefined;
    }
    recordError(state.rootSpan, err);
    state.rootSpan.end();
    this.#cleanupCallState(callId);
  }
}

/**
 * Creates the eve-owned telemetry bridge that replaces `@ai-sdk/otel`.
 * Event parameter types are derived directly from AI SDK's `Telemetry`
 * contract so changes to that contract fail at compile time.
 */
export function createEveOtelBridge(): Telemetry {
  return new EveOtelBridge();
}
