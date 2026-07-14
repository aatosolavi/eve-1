import { z } from "#compiled/zod/index.js";
import { extractCodexAccountIdFromToken } from "./auth.js";

/** A host-owned access credential for the experimental ChatGPT transport. */
export interface ExperimentalChatGptToken {
  /** Bearer token sent to the Codex Responses endpoint. */
  readonly token: string;
  /** Absolute expiration time in milliseconds since the Unix epoch. */
  readonly expiresAt: number;
  /** ChatGPT account selected for the request, when the token does not identify it. */
  readonly accountId?: string;
}

/** Why eve is asking the host to resolve a ChatGPT credential. */
export type ExperimentalChatGptTokenRequest =
  | { readonly reason: "request" }
  | { readonly previousToken: string; readonly reason: "refresh" };

/** Resolves or atomically refreshes the host-owned credential for one model request. */
export interface ExperimentalChatGptAuth {
  /**
   * A `refresh` request must serialize access to the durable credential,
   * re-read it, and return a newer usable, already-persisted generation when
   * another caller replaced `previousToken`. Otherwise it must refresh and
   * durably persist the rotated credential before resolving.
   */
  getToken(request: ExperimentalChatGptTokenRequest): Promise<ExperimentalChatGptToken>;
}

/** Configures `experimental_chatgpt` for a hosted process. */
export interface ExperimentalChatGptOptions {
  /** Host-owned authentication resolved separately for every model request. */
  readonly auth: ExperimentalChatGptAuth;
  /** OpenAI model ID. Defaults to `gpt-5.6-sol`. */
  readonly model?: string;
}

export type CodexCredentialSource =
  | { readonly kind: "codex-login" }
  | { readonly kind: "hosted"; readonly auth: ExperimentalChatGptAuth };

export interface HostedChatGptCredentials {
  readonly accessToken: string;
  readonly accountId?: string;
  readonly expiresAt: number;
}

const hostedChatGptTokenSchema = z
  .object({
    token: z.string().trim().min(1),
    accountId: z.string().trim().min(1).optional(),
    expiresAt: z.number().finite(),
  })
  .passthrough();

export async function readHostedChatGptCredentials(
  auth: ExperimentalChatGptAuth,
  request: ExperimentalChatGptTokenRequest,
): Promise<HostedChatGptCredentials> {
  const value: unknown = await auth.getToken(request);
  const parsed = hostedChatGptTokenSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "experimental_chatgpt auth.getToken() must return a non-empty token, a finite expiresAt in Unix milliseconds, and an optional non-empty accountId.",
    );
  }

  const accessToken = parsed.data.token;
  const accountId = parsed.data.accountId ?? extractCodexAccountIdFromToken(accessToken);
  return {
    accessToken,
    expiresAt: parsed.data.expiresAt,
    ...(accountId !== undefined && { accountId }),
  };
}
