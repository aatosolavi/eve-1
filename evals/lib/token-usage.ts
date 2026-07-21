import type { RunCompleteHook } from "@vercel/agent-eval";

/** Coding-model token counters preserved from an agent transcript. */
export interface TokenUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  totalInputTokens: number;
  totalTokens: number;
}

/** Documentation snapshot and treatment recorded with an eval result. */
export interface EvalResultMetadata {
  treatment: string;
  snapshot: "current" | "reference";
  gitRef: string;
  gitSha: string;
  dirty: boolean;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Aggregates coding-model usage from an agent's JSONL transcript. */
export function parseTokenUsage(transcript: string | undefined): TokenUsage | undefined {
  if (transcript === undefined) return undefined;

  let foundUsage = false;
  let inputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let outputTokens = 0;

  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;

    const event = JSON.parse(line) as {
      message?: {
        usage?: Record<string, unknown>;
      };
    };
    const usage = event.message?.usage;
    if (usage === undefined) continue;

    foundUsage = true;
    inputTokens += tokenCount(usage.input_tokens);
    cacheCreationInputTokens += tokenCount(usage.cache_creation_input_tokens);
    cacheReadInputTokens += tokenCount(usage.cache_read_input_tokens);
    outputTokens += tokenCount(usage.output_tokens);
  }

  if (!foundUsage) return undefined;

  const totalInputTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  return {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    totalInputTokens,
    totalTokens: totalInputTokens + outputTokens,
  };
}

/** Persists comparison metadata and coding-model usage with each result. */
export function createResultHook(metadata?: EvalResultMetadata): RunCompleteHook {
  return ({ runData }) => {
    const tokenUsage = parseTokenUsage(runData.transcript);
    const analysis: Record<string, unknown> = { ...runData.result.analysis };
    if (metadata !== undefined) analysis.documentationEval = metadata;
    if (tokenUsage !== undefined) analysis.tokenUsage = tokenUsage;

    return {
      ...runData,
      result: {
        ...runData.result,
        analysis,
      },
    };
  };
}
