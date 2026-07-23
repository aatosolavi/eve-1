import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveInvokeOperation, runInvoke } from "./invoke.js";
import { parseInvokeResumeInput } from "./result.js";

const cursor = {
  continuationToken: "eve:test",
  sessionId: "ses_1",
  streamIndex: 3,
};
const target = { kind: "remote" as const, serverUrl: "https://example.com/" };
const localTarget = {
  kind: "local" as const,
  serverUrl: "https://example.com/",
  workspaceRoot: "/repo",
};
const resume = { session: cursor, target };
const request = {
  action: { callId: "call-1", input: {}, kind: "tool-call" as const, toolName: "bash" },
  display: "confirmation" as const,
  options: [
    { id: "approve", label: "Approve" },
    { id: "deny", label: "Deny" },
  ],
  prompt: "Approve?",
  requestId: "approval-1",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseInvokeResumeInput", () => {
  it("accepts a complete result containing durable session coordinates", () => {
    const result = { status: "running" as const, resume };
    expect(parseInvokeResumeInput(result)).toEqual(result);
  });

  it("rejects standalone capsules, malformed results, and non-resumable results", () => {
    expect(() => parseInvokeResumeInput(resume)).toThrow("valid resumable eve invoke result");
    expect(() =>
      parseInvokeResumeInput({ status: "running", resume: { ...resume, session: {} } }),
    ).toThrow("valid resumable eve invoke result");
    expect(() => parseInvokeResumeInput({ status: "failed", message: "boom" })).toThrow(
      "valid resumable eve invoke result",
    );
  });
});

describe("runInvoke", () => {
  it("returns a resumable cursor immediately after the server accepts a turn", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ continuationToken: "eve:test", sessionId: "ses_1" }, { status: 202 }),
    );

    await expect(
      runInvoke({
        operation: { kind: "send", payload: { message: "do foo" } },
        target: localTarget,
        wait: false,
      }),
    ).resolves.toEqual({
      status: "running",
      resume: {
        session: { continuationToken: "eve:test", sessionId: "ses_1", streamIndex: 0 },
        target: { kind: "local" },
      },
    });
  });

  it("preserves an accepted session when its stream later rejects authorization", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ continuationToken: "eve:test", sessionId: "ses_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            code: "unauthorized",
            error: "Authorization is required for this route.",
          },
          { status: 401 },
        ),
      );

    await expect(
      runInvoke({
        headers: { authorization: "Bearer explicit" },
        operation: { kind: "send", payload: { message: "do foo" } },
        target: { ...target, workspaceRoot: "/repo" },
        wait: true,
      }),
    ).resolves.toMatchObject({
      status: "authentication-required",
      resume: { session: { sessionId: "ses_1" } },
    });
  });

  it("reduces a blocking input event into one resumable result", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ continuationToken: "eve:test", sessionId: "ses_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          { type: "input.requested", data: { requests: [request] } },
          {
            type: "session.waiting",
            data: { continuationToken: "eve:rekeyed", wait: "next-user-message" },
          },
        ]),
      );

    const result = await runInvoke({
      operation: { kind: "send", payload: { message: "do foo" } },
      target: localTarget,
      wait: true,
    });

    expect(result).toMatchObject({
      status: "input-required",
      requests: [request],
      resume: {
        session: { continuationToken: "eve:rekeyed", sessionId: "ses_1", streamIndex: 2 },
      },
    });
  });

  it("returns a resumable failure when a recoverable turn parks the session", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ continuationToken: "eve:test", sessionId: "ses_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "turn.failed",
            data: { code: "provider_error", message: "Model unavailable" },
          },
          {
            type: "session.waiting",
            data: { continuationToken: "eve:retry", wait: "next-user-message" },
          },
        ]),
      );

    await expect(
      runInvoke({
        operation: { kind: "send", payload: { message: "do foo" } },
        target: localTarget,
        wait: true,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      message: "Model unavailable",
      resume: {
        session: { continuationToken: "eve:retry", sessionId: "ses_1", streamIndex: 2 },
      },
    });
  });

  it("parks remote authorization at its durable boundary before returning", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ continuationToken: "eve:test", sessionId: "ses_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "authorization.required",
            data: { description: "Sign in", name: "linear", webhookUrl: "https://auth.test" },
          },
          {
            type: "session.waiting",
            data: { continuationToken: "eve:authorized", wait: "next-user-message" },
          },
        ]),
      );

    await expect(
      runInvoke({
        operation: { kind: "send", payload: { message: "do foo" } },
        target: { ...target, workspaceRoot: "/repo" },
        wait: true,
        headers: { authorization: "Bearer explicit" },
      }),
    ).resolves.toMatchObject({
      status: "authorization-required",
      authorizations: [{ name: "linear" }],
      resume: { session: { continuationToken: "eve:authorized", streamIndex: 2 } },
    });
  });

  it("returns every pending remote authorization", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ continuationToken: "eve:test", sessionId: "ses_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "authorization.required",
            data: { description: "Sign in", name: "linear", webhookUrl: "https://linear.test" },
          },
          {
            type: "authorization.required",
            data: { description: "Sign in", name: "github", webhookUrl: "https://github.test" },
          },
          {
            type: "session.waiting",
            data: { continuationToken: "eve:authorized", wait: "next-user-message" },
          },
        ]),
      );

    await expect(
      runInvoke({
        operation: { kind: "send", payload: { message: "do foo" } },
        target: { ...target, workspaceRoot: "/repo" },
        wait: true,
        headers: { authorization: "Bearer explicit" },
      }),
    ).resolves.toMatchObject({
      status: "authorization-required",
      authorizations: [{ name: "linear" }, { name: "github" }],
    });
  });

  it("rejects authorization that depends on a temporary local callback server", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ continuationToken: "eve:test", sessionId: "ses_1" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "authorization.required",
            data: {
              description: "Sign in",
              name: "linear",
              webhookUrl: "http://127.0.0.1:2000/eve/v1/connections/linear/callback/hook",
            },
          },
          {
            type: "session.waiting",
            data: { continuationToken: "eve:authorized", wait: "next-user-message" },
          },
        ]),
      );

    await expect(
      runInvoke({
        operation: { kind: "send", payload: { message: "do foo" } },
        target: localTarget,
        wait: true,
      }),
    ).resolves.toEqual({
      status: "failed",
      message:
        "Local eve invoke cannot pause for connection authorization because its temporary server must remain available for the callback. Run eve dev, then invoke its URL with --url.",
    });
  });

  it("does not preserve authorization after its completion event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      streamResponse([
        { type: "authorization.completed", data: { name: "linear", outcome: "authorized" } },
        {
          type: "message.completed",
          data: { finishReason: "stop", message: "done" },
        },
        {
          type: "session.waiting",
          data: { continuationToken: "eve:next", wait: "next-user-message" },
        },
      ]),
    );

    await expect(
      runInvoke({
        operation: { kind: "follow", resume },
        target: { ...target, workspaceRoot: "/repo" },
        wait: true,
        headers: { authorization: "Bearer explicit" },
      }),
    ).resolves.toMatchObject({ status: "completed", message: "done" });
  });
});

describe("resolveInvokeOperation", () => {
  it("starts an invocation from a prompt", () => {
    expect(resolveInvokeOperation({ prompt: "do foo" })).toEqual({
      kind: "send",
      payload: { message: "do foo" },
    });
  });

  it("forwards input response text for the harness to resolve against pending requests", () => {
    const previous = parseInvokeResumeInput({
      status: "input-required",
      requests: [request, { ...request, requestId: "approval-2" }],
      resume,
    });
    expect(resolveInvokeOperation({ previous, prompt: "Approve" })).toEqual({
      kind: "send",
      resume,
      payload: { message: "Approve" },
    });
  });

  it("follows authorization without posting another turn", () => {
    const previous = parseInvokeResumeInput({
      status: "authorization-required",
      authorizations: [{ description: "Sign in", name: "linear" }],
      resume,
    });
    expect(resolveInvokeOperation({ previous })).toEqual({ kind: "follow", resume });
  });
});

function streamResponse(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events)
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        controller.close();
      },
    }),
  );
}
