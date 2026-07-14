import type { LanguageModel } from "ai";

type LanguageModelInstance = Exclude<LanguageModel, string>;

// Authored modules can load another eve module copy; the global symbol keeps
// helper metadata readable by the compiler and runtime copies.
const CONTEXT_WINDOW_TOKENS_KEY: unique symbol = Symbol.for(
  "eve.language-model-context-window-tokens",
);

interface LanguageModelContextWindowMetadata {
  readonly [CONTEXT_WINDOW_TOKENS_KEY]: unknown;
}

export function setLanguageModelContextWindowTokens<Model extends LanguageModelInstance>(
  model: Model,
  contextWindowTokens: number,
): Model {
  Object.defineProperty(model, CONTEXT_WINDOW_TOKENS_KEY, {
    enumerable: false,
    value: contextWindowTokens,
  });
  return model;
}

export function getLanguageModelContextWindowTokens(
  model: LanguageModelInstance,
): number | undefined {
  if (!hasLanguageModelContextWindowMetadata(model)) {
    return undefined;
  }

  const contextWindowTokens = model[CONTEXT_WINDOW_TOKENS_KEY];
  return typeof contextWindowTokens === "number" &&
    Number.isInteger(contextWindowTokens) &&
    contextWindowTokens > 0
    ? contextWindowTokens
    : undefined;
}

function hasLanguageModelContextWindowMetadata(
  model: LanguageModelInstance,
): model is LanguageModelInstance & LanguageModelContextWindowMetadata {
  return CONTEXT_WINDOW_TOKENS_KEY in model;
}
