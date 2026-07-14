import type { LanguageModel } from "ai";
import { setLanguageModelContextWindowTokens } from "#shared/language-model-context-window.js";
import type { CodexCredentialSource, ExperimentalChatGptOptions } from "./chatgpt/credentials.js";
import { createCodexSubscriptionModel } from "./chatgpt/model.js";

export type {
  ExperimentalChatGptAuth,
  ExperimentalChatGptOptions,
  ExperimentalChatGptToken,
  ExperimentalChatGptTokenRequest,
} from "./chatgpt/credentials.js";

const OPENAI_PROVIDER_PREFIX = "openai/";
const DEFAULT_CHATGPT_MODEL = "gpt-5.6-sol";
const DEFAULT_CHATGPT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Creates a language model billed to a ChatGPT subscription instead of an API
 * key, served through the Codex backend.
 *
 * Defaults to `gpt-5.6-sol`. Pass a bare OpenAI model slug or an
 * `openai/`-prefixed id to override it; the Codex backend serves OpenAI models
 * only, so any other provider-qualified id is rejected. Model availability is
 * enforced by the Codex backend per account at call time, not at compile time.
 *
 * The string and no-argument forms read the Codex CLI login on the machine the
 * agent runs on. Hosted processes can instead pass an `auth.getToken` provider.
 * eve detects expiring credentials, requests a host-owned refresh, and retries
 * one replayable request when the Codex backend rejects its bearer. The host
 * must serialize refresh-token rotation and persist the rotated credential
 * before returning it. eve assumes a 200,000-token context window for models
 * returned by this helper; set `modelContextWindowTokens` on the agent to
 * override it:
 *
 * ```ts
 * export default defineAgent({
 *   model: experimental_chatgpt({
 *     auth: {
 *       getToken: (request) => chatGptCredentials.resolve(request),
 *     },
 *   }),
 * });
 * ```
 *
 * Experimental: the Codex backend is not a public API contract and may
 * change or reject subscription-backed access without notice.
 */
export function experimental_chatgpt(): LanguageModel;
export function experimental_chatgpt(model: string): LanguageModel;
export function experimental_chatgpt(options: ExperimentalChatGptOptions): LanguageModel;
export function experimental_chatgpt(
  input: string | ExperimentalChatGptOptions = DEFAULT_CHATGPT_MODEL,
): LanguageModel {
  const model = typeof input === "string" ? input : (input.model ?? DEFAULT_CHATGPT_MODEL);
  const trimmed = model.trim();
  const slug = trimmed.startsWith(OPENAI_PROVIDER_PREFIX)
    ? trimmed.slice(OPENAI_PROVIDER_PREFIX.length)
    : trimmed;

  if (slug.length === 0) {
    throw new Error(
      'Expected experimental_chatgpt "model" to name an OpenAI model, for example "gpt-5.6-sol".',
    );
  }

  if (slug.includes("/")) {
    throw new Error(
      `experimental_chatgpt serves OpenAI models through ChatGPT; received "${model}".`,
    );
  }

  const credentialSource: CodexCredentialSource =
    typeof input === "string" ? { kind: "codex-login" } : { kind: "hosted", auth: input.auth };

  return setLanguageModelContextWindowTokens(
    createCodexSubscriptionModel({ credentialSource, model: slug }),
    DEFAULT_CHATGPT_CONTEXT_WINDOW_TOKENS,
  );
}
