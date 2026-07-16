import { operationId, sessionId } from "./ids.js";
import type {
  ApprovalRequest,
  EffectCall,
  EffectResult,
  GenerateInput,
  GeneratedTurn,
  LoopRequest,
  RequestResult,
  RetryPolicy,
  ToolRequest,
  WireValue,
} from "./types.js";

const idempotentRetry = { idempotency: "required", maxAttempts: 2 } as const satisfies RetryPolicy;

export const effectDefinitions = {
  "execute-tool": { retry: idempotentRetry },
  generate: { retry: idempotentRetry },
} as const;

export function generateOperationId(
  input: Pick<GenerateInput, "generationOrdinal" | "sessionId" | "turnOrdinal">,
): EffectCall["id"] {
  return operationId(
    input.sessionId,
    input.turnOrdinal,
    `generate:${String(input.generationOrdinal)}`,
  );
}

export function executeToolOperationId(request: ApprovalRequest | ToolRequest): EffectCall["id"] {
  return operationId(sessionId(request.requestId), 0, "execute-tool");
}

export function createGenerateEffect(
  input: GenerateInput,
): Extract<EffectCall, { readonly name: "generate" }> {
  return {
    id: generateOperationId(input),
    input,
    name: "generate",
    retry: effectDefinitions.generate.retry,
  };
}

export function createExecuteToolEffect(
  request: ApprovalRequest | ToolRequest,
): Extract<EffectCall, { readonly name: "execute-tool" }> {
  return {
    id: executeToolOperationId(request),
    input: request,
    name: "execute-tool",
    retry: effectDefinitions["execute-tool"].retry,
  };
}

export function readGenerateResult(call: EffectCall, result: EffectResult): GeneratedTurn {
  const output = readSucceededResult(call, result);
  if (call.name !== "generate") {
    throw new EffectProtocolError(`Effect "${call.name}" is not a generation effect.`);
  }
  return parseGeneratedTurn(output);
}

export function readExecuteToolResult(call: EffectCall, result: EffectResult): RequestResult {
  const output = readSucceededResult(call, result);
  if (call.name !== "execute-tool") {
    throw new EffectProtocolError(`Effect "${call.name}" is not a tool effect.`);
  }
  if (
    !isWireRecord(output) ||
    output.requestId !== call.input.requestId ||
    typeof output.isError !== "boolean" ||
    !("value" in output)
  ) {
    throw new EffectProtocolError("Committed tool result does not match its request.");
  }
  return {
    isError: output.isError,
    requestId: output.requestId,
    value: output.value,
  };
}

export class EffectExhaustedError extends Error {
  readonly effect: EffectCall["name"];
  readonly failure: Extract<EffectResult, { readonly kind: "exhausted" }>["error"];

  constructor(
    effect: EffectCall["name"],
    failure: Extract<EffectResult, { readonly kind: "exhausted" }>["error"],
  ) {
    super(`Effect "${effect}" failed after backend retries: ${failure.message}`, {
      cause: new Error(failure.message),
    });
    this.effect = effect;
    this.failure = failure;
    this.name = "EffectExhaustedError";
  }
}

export class EffectProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EffectProtocolError";
  }
}

function readSucceededResult(call: EffectCall, result: EffectResult): WireValue {
  if (result.kind === "exhausted") throw new EffectExhaustedError(call.name, result.error);
  return result.output;
}

function parseGeneratedTurn(value: WireValue): GeneratedTurn {
  if (!isWireRecord(value)) throw new EffectProtocolError("Generated turn is not an object.");
  const assistant = parseAssistant(value.assistant);
  if (!Array.isArray(value.requests)) {
    throw new EffectProtocolError("Generated turn requests are not an array.");
  }
  const requests = value.requests.map(parseLoopRequest);
  if (
    assistant.requestIds.length !== requests.length ||
    assistant.requestIds.some((requestId, index) => requestId !== requests[index]?.requestId)
  ) {
    throw new EffectProtocolError("Generated turn request IDs do not match its assistant message.");
  }

  if (value.finish === null) {
    if (requests.length === 0) {
      throw new EffectProtocolError("Generated turn has neither a finish nor a request.");
    }
    return { assistant, finish: null, requests };
  }
  if (!isWireRecord(value.finish) || !("output" in value.finish) || requests.length > 0) {
    throw new EffectProtocolError("Generated turn finish does not match its requests.");
  }
  return { assistant, finish: { output: value.finish.output }, requests };
}

function parseAssistant(value: WireValue | undefined): GeneratedTurn["assistant"] {
  if (
    !isWireRecord(value) ||
    value.role !== "assistant" ||
    typeof value.content !== "string" ||
    !Array.isArray(value.requestIds) ||
    !value.requestIds.every((requestId) => typeof requestId === "string")
  ) {
    throw new EffectProtocolError("Generated assistant message is invalid.");
  }
  return { content: value.content, requestIds: value.requestIds, role: "assistant" };
}

function parseLoopRequest(value: WireValue): LoopRequest {
  if (!isWireRecord(value) || typeof value.requestId !== "string") {
    throw new EffectProtocolError("Generated request has no request ID.");
  }
  if (value.kind === "subagent") {
    if (typeof value.delayMs !== "number" || typeof value.message !== "string") {
      throw new EffectProtocolError("Generated subagent request is invalid.");
    }
    return {
      delayMs: value.delayMs,
      kind: "subagent",
      message: value.message,
      requestId: value.requestId,
    };
  }
  if (
    (value.kind === "tool" || value.kind === "approval") &&
    typeof value.name === "string" &&
    "input" in value
  ) {
    return {
      input: value.input,
      kind: value.kind,
      name: value.name,
      requestId: value.requestId,
    };
  }
  throw new EffectProtocolError("Generated request is invalid.");
}

function isWireRecord(
  value: WireValue | undefined,
): value is { readonly [key: string]: WireValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
