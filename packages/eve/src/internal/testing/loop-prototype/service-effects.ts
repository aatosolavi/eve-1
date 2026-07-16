import {
  EffectProtocolError,
  readExecuteToolResult,
  readGenerateResult,
} from "./effect-definitions.js";
import { lastUserMessage, resultsAfterLastUser } from "./transcript.js";
import { parseJsonWireValue } from "./wire.js";
import type { EffectCall, GeneratedTurn, RequestResult, WireValue } from "./types.js";

export { EffectProtocolError } from "./effect-definitions.js";

export class DeclaredEffectFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeclaredEffectFailure";
  }
}

export interface EffectLedger {
  commitResult(call: EffectCall, result: string): string;
  committedResult(call: EffectCall): string | null;
  recordAttempt(call: EffectCall): number;
  recordExecution(call: EffectCall): void;
  recordVisibleEffect(call: EffectCall): void;
}

export async function executeScriptedEffect(
  ledger: EffectLedger,
  call: EffectCall,
): Promise<WireValue> {
  const attempt = ledger.recordAttempt(call);
  ledger.recordVisibleEffect(call);
  const committed = ledger.committedResult(call);
  if (committed !== null) return parseCommittedResult(call, committed);

  ledger.recordExecution(call);
  const output = await evaluateScriptedEffect(call);
  const result = ledger.commitResult(call, stringifyEffectOutput(output));

  if (call.name === "generate" && call.input.scenario.kind === "retry-once" && attempt === 1) {
    throw new Error("Injected failure after the visible generation effect.");
  }

  return parseCommittedResult(call, result);
}

async function evaluateScriptedEffect(call: EffectCall): Promise<GeneratedTurn | RequestResult> {
  if (call.name === "execute-tool") {
    if (call.input.name === "fail") {
      throw new DeclaredEffectFailure("Injected terminal tool failure.");
    }
    const result: RequestResult = {
      isError: false,
      requestId: call.input.requestId,
      value: call.input.input,
    };
    return result;
  }

  if (call.input.scenario.kind === "infrastructure-fail") {
    throw new Error("Injected effect infrastructure failure.");
  }
  if (call.input.scenario.kind === "fail") {
    throw new DeclaredEffectFailure("Injected terminal generation failure.");
  }
  if (call.input.scenario.kind === "echo" && (call.input.scenario.delayMs ?? 0) > 0) {
    await delay(call.input.scenario.delayMs ?? 0);
  }
  return createGeneratedTurn(call);
}

function parseCommittedResult(call: EffectCall, value: string): WireValue {
  try {
    const parsed = parseJsonWireValue(value);
    const result = { kind: "succeeded" as const, output: parsed };
    if (call.name === "generate") readGenerateResult(call, result);
    else readExecuteToolResult(call, result);
    return parsed;
  } catch (error) {
    if (error instanceof EffectProtocolError) throw error;
    throw new EffectProtocolError("Committed effect result is not valid JSON.", { cause: error });
  }
}

function stringifyEffectOutput(output: GeneratedTurn | RequestResult): string {
  const value = JSON.stringify(output);
  if (value === undefined) {
    throw new EffectProtocolError("Scripted effect returned a non-JSON result.");
  }
  return value;
}

function createGeneratedTurn(
  call: Extract<EffectCall, { readonly name: "generate" }>,
): GeneratedTurn {
  const message = lastUserMessage(call.input.history);
  const results = resultsAfterLastUser(call.input.history);
  const scenario = call.input.scenario;

  if (scenario.kind === "fail" || scenario.kind === "infrastructure-fail") {
    throw new Error("Failure scenarios cannot produce a successful generated turn.");
  }

  if ((scenario.kind === "tool" || scenario.kind === "tool-fail") && results.length === 0) {
    const requestId = `${call.id}:tool`;
    return {
      assistant: { content: "Calling the echo tool.", requestIds: [requestId], role: "assistant" },
      finish: null,
      requests: [
        {
          input: message,
          kind: "tool",
          name: scenario.kind === "tool-fail" ? "fail" : "echo",
          requestId,
        },
      ],
    };
  }

  if (scenario.kind === "approval" && results.length === 0) {
    const requestId = `${call.id}:approval`;
    return {
      assistant: {
        content: "Waiting for approval to call the echo tool.",
        requestIds: [requestId],
        role: "assistant",
      },
      finish: null,
      requests: [{ input: message, kind: "approval", name: "echo", requestId }],
    };
  }

  if (scenario.kind === "children" && results.length === 0) {
    const requests = scenario.children.map((child, index) => ({
      delayMs: child.delayMs,
      kind: "subagent" as const,
      message: child.message,
      requestId: `${call.id}:child:${String(index)}`,
    }));
    return {
      assistant: {
        content: "Delegating child work.",
        requestIds: requests.map((request) => request.requestId),
        role: "assistant",
      },
      finish: null,
      requests,
    };
  }

  const output = resolveOutput(scenario.kind, message, results);
  return {
    assistant: { content: String(output), requestIds: [], role: "assistant" },
    finish: { output },
    requests: [],
  };
}

function resolveOutput(
  scenario: "approval" | "children" | "echo" | "retry-once" | "tool" | "tool-fail",
  message: string,
  results: readonly RequestResult[],
): WireValue {
  switch (scenario) {
    case "echo":
      return `echo:${message}`;
    case "retry-once":
      return `retry:${message}`;
    case "tool":
    case "tool-fail":
      return results[0]?.value ?? "missing tool result";
    case "approval":
      return results[0]?.isError === true ? "approval:denied" : (results[0]?.value ?? null);
    case "children":
      return results.map((result) => result.value);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
