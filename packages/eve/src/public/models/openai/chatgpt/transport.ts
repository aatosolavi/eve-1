import { z } from "#compiled/zod/index.js";
import {
  extractCodexAccountIdFromToken,
  isFreshCodexAccessToken,
  readCodexAuthCredentials,
  writeCodexAuthCredentials,
  type CodexAuthCredentials,
  type CodexChatGptCredentials,
  type CodexRefreshedTokens,
} from "./auth.js";
import {
  readHostedChatGptCredentials,
  type CodexCredentialSource,
  type HostedChatGptCredentials,
} from "./credentials.js";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_AUTH_ISSUER = "https://auth.openai.com";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_REFRESH_SKEW_MS = 60_000;

type Fetch = typeof globalThis.fetch;
type FetchInput = Parameters<Fetch>[0];
type CodexCredentialsWriter = (input: {
  readonly credentials: CodexChatGptCredentials;
  readonly tokens: CodexRefreshedTokens;
}) => Promise<CodexChatGptCredentials>;
type RefreshChatGptCredentialsInput = {
  readonly clientId: string;
  readonly credentials: CodexChatGptCredentials & { readonly refreshToken: string };
  readonly fetch: Fetch;
  readonly issuer: string;
  readonly writeCredentials: CodexCredentialsWriter;
};

export interface CodexTransportOptions {
  readonly clientId?: string;
  readonly codexApiEndpoint?: string;
  readonly credentialSource?: CodexCredentialSource;
  readonly fetch?: Fetch;
  readonly issuer?: string;
  readonly now?: () => number;
  readonly readCredentials?: () => Promise<CodexAuthCredentials>;
  readonly writeCredentials?: CodexCredentialsWriter;
}

const codexRefreshResponseSchema = z
  .object({
    access_token: z.string().trim().min(1),
    id_token: z.string().trim().min(1).optional(),
    refresh_token: z.string().trim().min(1),
  })
  .passthrough();

/**
 * AI SDK's OpenAI client gives eve one per-request hook: `fetch`. Codex needs
 * that hook to choose credentials and endpoint per auth source, not just to
 * swap the base URL. Local API-key logins stay on OpenAI's Responses endpoint;
 * local and hosted ChatGPT credentials use the Codex backend.
 */
export function createCodexFetch(options: CodexTransportOptions = {}): Fetch {
  const httpFetch = options.fetch ?? fetch;
  const readCredentials = options.readCredentials ?? readCodexAuthCredentials;
  const now = options.now ?? Date.now;
  const writeCredentials = options.writeCredentials ?? createDefaultCodexCredentialsWriter(now);
  const issuer = options.issuer ?? OPENAI_AUTH_ISSUER;
  const clientId = options.clientId ?? OPENAI_CLIENT_ID;
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT;
  const credentialSource = options.credentialSource ?? { kind: "codex-login" };
  let refreshPromise: Promise<CodexChatGptCredentials> | undefined;

  return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const headers = cloneHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.delete("authorization");
    headers.delete("ChatGPT-Account-Id");
    headers.set("originator", "eve");

    switch (credentialSource.kind) {
      case "hosted": {
        const hostedAuth = credentialSource.auth;
        const current = await readHostedChatGptCredentials(hostedAuth, {
          reason: "request",
        });
        const credentials = isFreshHostedCredential(current, now())
          ? current
          : await refreshHostedCredential(current);
        const response = await sendHostedRequest(credentials);
        if (response.status !== 401 || !isReplayableRequest(input, init)) {
          return response;
        }

        await discardResponseBody(response);
        const refreshed = await refreshHostedCredential(credentials);
        return sendHostedRequest(refreshed);

        async function refreshHostedCredential(
          previous: HostedChatGptCredentials,
        ): Promise<HostedChatGptCredentials> {
          const refreshed = await readHostedChatGptCredentials(hostedAuth, {
            previousToken: previous.accessToken,
            reason: "refresh",
          });
          if (!isFreshHostedCredential(refreshed, now())) {
            throw new Error(
              "experimental_chatgpt auth.getToken() returned an expiring token for a refresh request.",
            );
          }
          return refreshed;
        }

        function sendHostedRequest(credentials: HostedChatGptCredentials): Promise<Response> {
          return httpFetch(
            rewriteCodexEndpoint(requestUrl(input), codexApiEndpoint),
            fetchInit(input, init, chatGptHeaders(headers, credentials)),
          );
        }
      }
      case "codex-login":
        break;
      default: {
        const exhaustive: never = credentialSource;
        return exhaustive;
      }
    }

    const credentials = await readCredentials();

    if (credentials.kind === "api-key") {
      headers.set("authorization", `Bearer ${credentials.apiKey}`);
      return httpFetch(input, fetchInit(input, init, headers));
    }

    const chatGptCredentials = await authenticateChatGpt(credentials);
    const response = await sendLocalChatGptRequest(chatGptCredentials);
    if (response.status !== 401 || !isReplayableRequest(input, init)) {
      return response;
    }

    await discardResponseBody(response);
    const refreshed = await refreshRejectedChatGptCredential(chatGptCredentials.accessToken);
    return sendLocalChatGptRequest(refreshed);

    async function authenticateChatGpt(
      current: CodexChatGptCredentials,
    ): Promise<CodexChatGptCredentials & { readonly accessToken: string }> {
      if (
        current.accessToken !== undefined &&
        isFreshCodexAccessToken(current.accessToken, now())
      ) {
        return { ...current, accessToken: current.accessToken };
      }
      return refreshLocalChatGptCredential(current);
    }

    async function refreshRejectedChatGptCredential(
      rejectedAccessToken: string,
    ): Promise<CodexChatGptCredentials & { readonly accessToken: string }> {
      const latest = await readCredentials();
      if (latest.kind !== "chatgpt") {
        throw new Error("Expected ChatGPT Codex credentials after the Codex backend returned 401.");
      }
      if (
        latest.accessToken !== undefined &&
        latest.accessToken !== rejectedAccessToken &&
        isFreshCodexAccessToken(latest.accessToken, now())
      ) {
        return { ...latest, accessToken: latest.accessToken };
      }
      return refreshLocalChatGptCredential(latest);
    }

    async function refreshLocalChatGptCredential(
      current: CodexChatGptCredentials,
    ): Promise<CodexChatGptCredentials & { readonly accessToken: string }> {
      const refreshToken = current.refreshToken;
      if (refreshToken === undefined) {
        throw new Error(
          `Codex ChatGPT login state at ${current.authPath} does not include a refresh token. Run \`codex login\` again before using experimental_chatgpt.`,
        );
      }
      if (refreshPromise === undefined) {
        refreshPromise = refreshChatGptCredentials({
          clientId,
          credentials: { ...current, refreshToken },
          fetch: httpFetch,
          issuer,
          writeCredentials,
        }).finally(() => {
          refreshPromise = undefined;
        });
      }
      const refreshed = await refreshPromise;
      if (refreshed.accessToken === undefined) {
        throw new Error("Codex token refresh did not return an access token.");
      }
      return { ...refreshed, accessToken: refreshed.accessToken };
    }

    function sendLocalChatGptRequest(
      current: CodexChatGptCredentials & { readonly accessToken: string },
    ): Promise<Response> {
      // Response storage (`store: false`, which the Codex backend requires) is
      // injected by createCodexSubscriptionModel's call-options wrapper — the
      // transport only owns credentials and the endpoint rewrite.
      return httpFetch(
        rewriteCodexEndpoint(requestUrl(input), codexApiEndpoint),
        fetchInit(input, init, chatGptHeaders(headers, current)),
      );
    }
  };
}

export function rewriteCodexEndpoint(input: string, codexApiEndpoint = CODEX_API_ENDPOINT): string {
  const url = new URL(input);
  if (url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions")) {
    return codexApiEndpoint;
  }
  return input;
}

async function refreshChatGptCredentials(
  input: RefreshChatGptCredentialsInput,
): Promise<CodexChatGptCredentials> {
  const response = await input.fetch(`${input.issuer}/oauth/token`, {
    body: new URLSearchParams({
      client_id: input.clientId,
      grant_type: "refresh_token",
      refresh_token: input.credentials.refreshToken,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Codex token refresh failed with status ${response.status}. Run \`codex login\` again.`,
    );
  }

  const tokens = parseRefreshResponse(await response.json());
  return input.writeCredentials({
    credentials: input.credentials,
    tokens: {
      ...tokens,
      accountId:
        tokens.accountId ??
        input.credentials.accountId ??
        extractCodexAccountIdFromToken(tokens.idToken) ??
        extractCodexAccountIdFromToken(tokens.accessToken),
    },
  });
}

function parseRefreshResponse(value: unknown): CodexRefreshedTokens {
  const parsed = codexRefreshResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Codex token refresh did not return access_token and refresh_token.");
  }
  const accessToken = parsed.data.access_token;
  const refreshToken = parsed.data.refresh_token;
  const idToken = parsed.data.id_token;

  return {
    accessToken,
    refreshToken,
    ...(idToken !== undefined && { idToken }),
    accountId:
      extractCodexAccountIdFromToken(idToken) ?? extractCodexAccountIdFromToken(accessToken),
  };
}

function createDefaultCodexCredentialsWriter(now: () => number): CodexCredentialsWriter {
  return (input) =>
    writeCodexAuthCredentials({
      ...input,
      now: () => new Date(now()),
    });
}

function cloneHeaders(input: RequestInit["headers"] | undefined): Headers {
  const headers = new Headers(input);
  return headers;
}

function chatGptHeaders(
  base: Headers,
  credentials: { readonly accessToken: string; readonly accountId?: string },
): Headers {
  const headers = new Headers(base);
  headers.set("authorization", `Bearer ${credentials.accessToken}`);
  if (credentials.accountId !== undefined) {
    headers.set("ChatGPT-Account-Id", credentials.accountId);
  }
  return headers;
}

function isFreshHostedCredential(credentials: HostedChatGptCredentials, now: number): boolean {
  return credentials.expiresAt - TOKEN_REFRESH_SKEW_MS > now;
}

function isReplayableRequest(input: FetchInput, init: RequestInit | undefined): boolean {
  return !(input instanceof Request) && (init?.body === undefined || typeof init.body === "string");
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function requestUrl(input: FetchInput): string {
  if (input instanceof Request) return input.url;
  return input.toString();
}

function fetchInit(
  input: FetchInput,
  init: RequestInit | undefined,
  headers: Headers,
): RequestInit {
  if (init !== undefined) {
    return { ...init, headers };
  }
  if (input instanceof Request) {
    return {
      body: input.body,
      cache: input.cache,
      credentials: input.credentials,
      headers,
      integrity: input.integrity,
      keepalive: input.keepalive,
      method: input.method,
      mode: input.mode,
      redirect: input.redirect,
      referrer: input.referrer,
      referrerPolicy: input.referrerPolicy,
      signal: input.signal,
    };
  }
  return { headers };
}
