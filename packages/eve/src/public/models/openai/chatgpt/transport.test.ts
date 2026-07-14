import { describe, expect, it, vi } from "vitest";

import type {
  CodexAuthCredentials,
  CodexChatGptCredentials,
  CodexRefreshedTokens,
} from "./auth.js";
import type { ExperimentalChatGptTokenRequest } from "./credentials.js";
import { createCodexFetch, rewriteCodexEndpoint } from "./transport.js";
import { createUnsignedJwt } from "./unsigned-jwt.js";

const CODEX_ENDPOINT = "https://chatgpt.test/backend-api/codex/responses";
const ISSUER = "https://auth.test";
const NOW = 1_800_000_000_000;

describe("Codex direct transport", () => {
  it("rewrites OAuth Responses requests to the Codex backend with refreshed ChatGPT auth", async () => {
    const refreshedAccessToken = createUnsignedJwt({
      exp: 2_000_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-new" },
    });
    const requests: RecordedRequest[] = [];
    const httpFetch = createRecordingFetch(requests, async (url) => {
      if (url === `${ISSUER}/oauth/token`) {
        return Response.json({
          access_token: refreshedAccessToken,
          id_token: createUnsignedJwt({ chatgpt_account_id: "acct-new" }),
          refresh_token: "refresh-new",
        });
      }
      return Response.json({ ok: true });
    });
    const writeCredentials = vi.fn(
      async (input: {
        readonly credentials: CodexChatGptCredentials;
        readonly tokens: CodexRefreshedTokens;
      }): Promise<CodexChatGptCredentials> => ({
        kind: "chatgpt",
        accessToken: input.tokens.accessToken,
        accountId: input.tokens.accountId,
        authPath: input.credentials.authPath,
        codexHome: input.credentials.codexHome,
        refreshToken: input.tokens.refreshToken,
      }),
    );
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      fetch: httpFetch,
      issuer: ISSUER,
      now: () => 1_800_000_000_000,
      readCredentials: async () => ({
        kind: "chatgpt",
        accessToken: createUnsignedJwt({ exp: 1 }),
        authPath: "/home/user/.codex/auth.json",
        codexHome: "/home/user/.codex",
        refreshToken: "refresh-old",
      }),
      writeCredentials,
    });

    await codexFetch("https://api.openai.com/v1/responses", {
      body: '{"stream":true}',
      headers: {
        authorization: "Bearer placeholder",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`${ISSUER}/oauth/token`);
    expect(requests[0]?.body).toContain("grant_type=refresh_token");
    expect(requests[0]?.body).toContain("refresh_token=refresh-old");
    expect(writeCredentials).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ refreshToken: "refresh-old" }),
      tokens: expect.objectContaining({
        accessToken: refreshedAccessToken,
        accountId: "acct-new",
        refreshToken: "refresh-new",
      }),
    });
    expect(requests[1]).toMatchObject({
      method: "POST",
      url: CODEX_ENDPOINT,
    });
    expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({ stream: true });
    expect(requests[1]?.headers.get("authorization")).toBe(`Bearer ${refreshedAccessToken}`);
    expect(requests[1]?.headers.get("ChatGPT-Account-Id")).toBe("acct-new");
    expect(requests[1]?.headers.get("originator")).toBe("eve");
    expect(requests[1]?.headers.get("content-type")).toBe("application/json");
  });

  it("leaves API-key auth on the OpenAI API endpoint", async () => {
    const requests: RecordedRequest[] = [];
    const codexFetch = createCodexFetch({
      fetch: createRecordingFetch(requests),
      readCredentials: async (): Promise<CodexAuthCredentials> => ({
        kind: "api-key",
        apiKey: "sk-test",
        authPath: "/home/user/.codex/auth.json",
        codexHome: "/home/user/.codex",
      }),
    });

    await codexFetch("https://api.openai.com/v1/responses", {
      headers: { authorization: "Bearer placeholder" },
      method: "POST",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(requests[0]?.headers.has("ChatGPT-Account-Id")).toBe(false);
    expect(requests[0]?.headers.get("originator")).toBe("eve");
  });

  it("leaves API-key request bodies unchanged", async () => {
    const requests: RecordedRequest[] = [];
    const codexFetch = createCodexFetch({
      fetch: createRecordingFetch(requests),
      readCredentials: async (): Promise<CodexAuthCredentials> => ({
        kind: "api-key",
        apiKey: "sk-test",
        authPath: "/home/user/.codex/auth.json",
        codexHome: "/home/user/.codex",
      }),
    });

    await codexFetch("https://api.openai.com/v1/responses", {
      body: '{"model":"gpt-5.2-codex","input":[],"store":true}',
      method: "POST",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toBe('{"model":"gpt-5.2-codex","input":[],"store":true}');
  });

  it("resolves host-owned credentials for every request without using local auth storage", async () => {
    const requests: RecordedRequest[] = [];
    const hostedCredentials = [
      { token: "hosted-token-one", accountId: "acct-one", expiresAt: NOW + 120_000 },
      { token: "hosted-token-two", accountId: "acct-two", expiresAt: NOW + 120_000 },
    ];
    let credentialIndex = 0;
    const getToken = vi.fn(async (_request: ExperimentalChatGptTokenRequest) => {
      return hostedCredentials[credentialIndex++]!;
    });
    const readCredentials = vi.fn(async (): Promise<CodexAuthCredentials> => {
      throw new Error("local credentials should not be read");
    });
    const writeCredentials = vi.fn(
      async (_input: {
        readonly credentials: CodexChatGptCredentials;
        readonly tokens: CodexRefreshedTokens;
      }): Promise<CodexChatGptCredentials> => {
        throw new Error("local credentials should not be written");
      },
    );
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      credentialSource: { kind: "hosted", auth: { getToken } },
      fetch: createRecordingFetch(requests),
      now: () => NOW,
      readCredentials,
      writeCredentials,
    });

    await codexFetch("https://api.openai.com/v1/responses", { method: "POST" });
    await codexFetch("https://api.openai.com/v1/responses", { method: "POST" });

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenNthCalledWith(1, { reason: "request" });
    expect(getToken).toHaveBeenNthCalledWith(2, { reason: "request" });
    expect(readCredentials).not.toHaveBeenCalled();
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(requests.map((request) => request.url)).toEqual([CODEX_ENDPOINT, CODEX_ENDPOINT]);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer hosted-token-one",
      "Bearer hosted-token-two",
    ]);
    expect(requests.map((request) => request.headers.get("ChatGPT-Account-Id"))).toEqual([
      "acct-one",
      "acct-two",
    ]);
  });

  it("refreshes an expiring hosted credential before sending the request", async () => {
    const requests: RecordedRequest[] = [];
    const getToken = vi.fn(async (request: ExperimentalChatGptTokenRequest) => {
      if (request.reason === "refresh") {
        return { token: "hosted-token-new", expiresAt: NOW + 120_000 };
      }
      return { token: "hosted-token-old", expiresAt: NOW + 30_000 };
    });
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      credentialSource: { kind: "hosted", auth: { getToken } },
      fetch: createRecordingFetch(requests),
      now: () => NOW,
    });

    await codexFetch("https://api.openai.com/v1/responses", { method: "POST" });

    expect(getToken).toHaveBeenNthCalledWith(1, { reason: "request" });
    expect(getToken).toHaveBeenNthCalledWith(2, {
      reason: "refresh",
      previousToken: "hosted-token-old",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer hosted-token-new");
  });

  it("refreshes and retries one replayable hosted request after a 401", async () => {
    const requests: RecordedRequest[] = [];
    let attempt = 0;
    const getToken = vi.fn(async (request: ExperimentalChatGptTokenRequest) => ({
      token: request.reason === "refresh" ? "hosted-token-new" : "hosted-token-old",
      expiresAt: NOW + 120_000,
    }));
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      credentialSource: { kind: "hosted", auth: { getToken } },
      fetch: createRecordingFetch(requests, () => {
        attempt += 1;
        return attempt === 1 ? new Response(null, { status: 401 }) : Response.json({ ok: true });
      }),
      now: () => NOW,
    });

    const response = await codexFetch("https://api.openai.com/v1/responses", {
      body: '{"stream":true}',
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(getToken).toHaveBeenNthCalledWith(1, { reason: "request" });
    expect(getToken).toHaveBeenNthCalledWith(2, {
      reason: "refresh",
      previousToken: "hosted-token-old",
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.body)).toEqual(['{"stream":true}', '{"stream":true}']);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer hosted-token-old",
      "Bearer hosted-token-new",
    ]);
  });

  it("waits for hosted refresh persistence before sending a request", async () => {
    const requests: RecordedRequest[] = [];
    let finishPersistence: (() => void) | undefined;
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const getToken = vi.fn(async (request: ExperimentalChatGptTokenRequest) => {
      if (request.reason === "refresh") {
        await persistence;
        return { token: "hosted-token-new", expiresAt: NOW + 120_000 };
      }
      return { token: "hosted-token-old", expiresAt: NOW + 30_000 };
    });
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      credentialSource: { kind: "hosted", auth: { getToken } },
      fetch: createRecordingFetch(requests),
      now: () => NOW,
    });

    const response = codexFetch("https://api.openai.com/v1/responses", { method: "POST" });
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledTimes(2));
    expect(requests).toHaveLength(0);

    finishPersistence?.();
    await response;

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer hosted-token-new");
  });

  it("does not refresh or retry a non-replayable hosted request after a 401", async () => {
    const requests: RecordedRequest[] = [];
    const getToken = vi.fn(async (_request: ExperimentalChatGptTokenRequest) => ({
      token: "hosted-token",
      expiresAt: NOW + 120_000,
    }));
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      credentialSource: { kind: "hosted", auth: { getToken } },
      fetch: createRecordingFetch(requests, () => new Response(null, { status: 401 })),
      now: () => NOW,
    });

    const response = await codexFetch(
      new Request("https://api.openai.com/v1/responses", {
        body: '{"stream":true}',
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(getToken).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledWith({ reason: "request" });
    expect(requests).toHaveLength(1);
  });

  it("bounds hosted 401 recovery to one refresh and one retry", async () => {
    const requests: RecordedRequest[] = [];
    const getToken = vi.fn(async (request: ExperimentalChatGptTokenRequest) => ({
      token: request.reason === "refresh" ? "hosted-token-new" : "hosted-token-old",
      expiresAt: NOW + 120_000,
    }));
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      credentialSource: { kind: "hosted", auth: { getToken } },
      fetch: createRecordingFetch(requests, () => new Response(null, { status: 401 })),
      now: () => NOW,
    });

    const response = await codexFetch("https://api.openai.com/v1/responses", {
      body: "{}",
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
  });

  it("rejects an invalid hosted expiration before sending a request", async () => {
    const requests: RecordedRequest[] = [];
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      credentialSource: {
        kind: "hosted",
        auth: {
          getToken: async () => ({ expiresAt: Number.NaN, token: "hosted-token" }),
        },
      },
      fetch: createRecordingFetch(requests),
      now: () => NOW,
    });

    await expect(codexFetch("https://api.openai.com/v1/responses")).rejects.toThrow(
      "finite expiresAt",
    );
    expect(requests).toHaveLength(0);
  });

  it("rejects a hosted refresh result that is still expiring", async () => {
    const requests: RecordedRequest[] = [];
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      credentialSource: {
        kind: "hosted",
        auth: {
          getToken: async () => ({ expiresAt: NOW + 30_000, token: "hosted-token" }),
        },
      },
      fetch: createRecordingFetch(requests),
      now: () => NOW,
    });

    await expect(codexFetch("https://api.openai.com/v1/responses")).rejects.toThrow(
      "returned an expiring token for a refresh request",
    );
    expect(requests).toHaveLength(0);
  });

  it("rejects invalid host-owned credentials before sending a request", async () => {
    const requests: RecordedRequest[] = [];
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      credentialSource: {
        kind: "hosted",
        auth: { getToken: async () => ({ expiresAt: NOW + 120_000, token: " " }) },
      },
      fetch: createRecordingFetch(requests),
    });

    await expect(codexFetch("https://api.openai.com/v1/responses")).rejects.toThrow(
      "must return a non-empty token",
    );
    expect(requests).toHaveLength(0);
  });

  it("deduplicates concurrent ChatGPT token refreshes", async () => {
    const requests: RecordedRequest[] = [];
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const httpFetch = createRecordingFetch(requests, async (url) => {
      if (url === `${ISSUER}/oauth/token`) {
        await refreshGate;
        return Response.json({
          access_token: createUnsignedJwt({ exp: 2_000_000_000 }),
          refresh_token: "refresh-new",
        });
      }
      return Response.json({ ok: true });
    });
    const writeCredentials = vi.fn(
      async (input: {
        readonly credentials: CodexChatGptCredentials;
        readonly tokens: CodexRefreshedTokens;
      }): Promise<CodexChatGptCredentials> => ({
        ...input.credentials,
        accessToken: input.tokens.accessToken,
        refreshToken: input.tokens.refreshToken,
      }),
    );
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      fetch: httpFetch,
      issuer: ISSUER,
      now: () => 1_800_000_000_000,
      readCredentials: async () => ({
        kind: "chatgpt",
        authPath: "/home/user/.codex/auth.json",
        codexHome: "/home/user/.codex",
        refreshToken: "refresh-old",
      }),
      writeCredentials,
    });

    const first = codexFetch("https://api.openai.com/v1/responses");
    const second = codexFetch("https://api.openai.com/v1/responses");
    await vi.waitFor(() =>
      expect(requests.filter((request) => request.url === `${ISSUER}/oauth/token`)).toHaveLength(1),
    );
    releaseRefresh?.();
    await Promise.all([first, second]);

    expect(requests.filter((request) => request.url === `${ISSUER}/oauth/token`)).toHaveLength(1);
    expect(writeCredentials).toHaveBeenCalledOnce();
    expect(requests.filter((request) => request.url === CODEX_ENDPOINT)).toHaveLength(2);
  });

  it("refreshes and retries one replayable local ChatGPT request after a 401", async () => {
    const requests: RecordedRequest[] = [];
    const oldAccessToken = createUnsignedJwt({ exp: 2_000_000_000 });
    const newAccessToken = createUnsignedJwt({ exp: 2_100_000_000 });
    let codexAttempts = 0;
    let persisted: CodexChatGptCredentials = {
      kind: "chatgpt",
      accessToken: oldAccessToken,
      authPath: "/home/user/.codex/auth.json",
      codexHome: "/home/user/.codex",
      refreshToken: "refresh-old",
    };
    const httpFetch = createRecordingFetch(requests, async (url) => {
      if (url === `${ISSUER}/oauth/token`) {
        return Response.json({
          access_token: newAccessToken,
          refresh_token: "refresh-new",
        });
      }
      codexAttempts += 1;
      return codexAttempts === 1
        ? new Response(null, { status: 401 })
        : Response.json({ ok: true });
    });
    const writeCredentials = vi.fn(
      async (input: {
        readonly credentials: CodexChatGptCredentials;
        readonly tokens: CodexRefreshedTokens;
      }): Promise<CodexChatGptCredentials> => {
        persisted = {
          ...input.credentials,
          accessToken: input.tokens.accessToken,
          refreshToken: input.tokens.refreshToken,
        };
        return persisted;
      },
    );
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      fetch: httpFetch,
      issuer: ISSUER,
      now: () => NOW,
      readCredentials: async () => persisted,
      writeCredentials,
    });

    const response = await codexFetch("https://api.openai.com/v1/responses", {
      body: "{}",
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(requests.map((request) => request.url)).toEqual([
      CODEX_ENDPOINT,
      `${ISSUER}/oauth/token`,
      CODEX_ENDPOINT,
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${oldAccessToken}`);
    expect(requests[2]?.headers.get("authorization")).toBe(`Bearer ${newAccessToken}`);
    expect(writeCredentials).toHaveBeenCalledOnce();
  });

  it("matches OpenCode's OAuth URL rewrite boundary", () => {
    expect(rewriteCodexEndpoint("https://api.openai.com/v1/responses", CODEX_ENDPOINT)).toBe(
      CODEX_ENDPOINT,
    );
    expect(rewriteCodexEndpoint("https://api.openai.com/chat/completions", CODEX_ENDPOINT)).toBe(
      CODEX_ENDPOINT,
    );
    expect(rewriteCodexEndpoint("https://api.openai.com/v1/models", CODEX_ENDPOINT)).toBe(
      "https://api.openai.com/v1/models",
    );
  });
});

interface RecordedRequest {
  readonly body: string | undefined;
  readonly headers: Headers;
  readonly method: string | undefined;
  readonly url: string;
}

function createRecordingFetch(
  requests: RecordedRequest[],
  responseForUrl: (url: string) => Response | Promise<Response> = () => Response.json({ ok: true }),
): typeof fetch {
  return async (input, init) => {
    requests.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: new Headers(init?.headers),
      method: init?.method,
      url: input instanceof Request ? input.url : input.toString(),
    });
    return responseForUrl(requests[requests.length - 1]!.url);
  };
}
