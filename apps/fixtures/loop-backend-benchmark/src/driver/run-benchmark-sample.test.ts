import type { HandleMessageStreamEvent } from "eve/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runBenchmarkSample } from "./run-benchmark-sample.js";
import { createValidEvents, TEST_NONCE, TEST_VERIFICATION } from "./test-events.js";

const SAMPLE_ID = "sample-01";
const SERVER_AT = "2026-07-10T12:00:00.000Z";
const VERCEL_OIDC_TOKEN = "vercel-oidc-test-token";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("runBenchmarkSample", () => {
  it("measures one canonical client turn and propagates the sample header", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock++);
    const seenHeaders: Array<string | null> = [];
    const seenAuthorizationHeaders: Array<string | null> = [];
    const seenRedirects: Array<"error" | "follow" | "manual" | undefined> = [];
    const seenTrustedOidcHeaders: Array<string | null> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      seenHeaders.push(headers.get("x-eve-benchmark-sample-id"));
      seenAuthorizationHeaders.push(headers.get("authorization"));
      seenRedirects.push(init?.redirect);
      seenTrustedOidcHeaders.push(headers.get("x-vercel-trusted-oidc-idp-token"));

      if (init?.method === "POST") {
        expect(requestUrl(input)).toBe("https://benchmark.example/eve/v1/session");
        expect(init.body).toBe(JSON.stringify({ message: TEST_NONCE }));
        return Response.json({ continuationToken: "next-token", sessionId: "session-01" });
      }

      expect(requestUrl(input)).toBe("https://benchmark.example/eve/v1/session/session-01/stream");
      const body = `${createValidEvents()
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`;
      return new Response(body, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runBenchmarkSample(
      {
        nonce: TEST_NONCE,
        runtimeKind: "inline",
        sampleId: SAMPLE_ID,
        targetKind: "vercel",
        targetUrl: "https://benchmark.example",
      },
      { vercelOidcToken: VERCEL_OIDC_TOKEN },
    );

    expect(result.outcome).toBe("valid");
    if (result.outcome !== "valid") return;

    expect(result.finalVisibleMessage).toBe(TEST_VERIFICATION);
    expect(result.sessionId).toBe("session-01");
    expect(result.measurements.postAckMs).toBeGreaterThanOrEqual(0);
    expect(result.measurements.firstDecodedEventMs).toBeGreaterThanOrEqual(
      result.measurements.postAckMs,
    );
    expect(result.measurements.firstVisibleTextMs).toBeGreaterThanOrEqual(
      result.measurements.firstDecodedEventMs ?? 0,
    );
    expect(result.measurements.sessionWaitingReducedMs).toBeGreaterThanOrEqual(
      result.measurements.firstVisibleTextMs ?? 0,
    );
    expect(result.measurements.reducerTotalMs).toBeGreaterThanOrEqual(0);
    expect(result.measurements.events).toHaveLength(createValidEvents().length);
    expect(result.measurements.events[0]?.serverAt).toBe(SERVER_AT);
    expect(result.measurements.firstDecodedEventMs).toBe(
      result.measurements.events[0]?.receivedAtMs,
    );
    expect(result.measurements.firstVisibleTextMs).toBe(
      result.measurements.events.find((event) => event.eventType === "message.appended")
        ?.reducedAtMs,
    );
    expect(result.measurements.sessionWaitingReducedMs).toBe(
      result.measurements.events.find((event) => event.eventType === "session.waiting")
        ?.reducedAtMs,
    );
    expect(result.measurements.reducerTotalMs).toBe(
      result.measurements.events.reduce((total, event) => total + event.reduceDurationMs, 0),
    );
    expect([
      result.measurements.postAckToSessionStartedEventReceivedMs,
      result.measurements.sessionStartedToToolRequestEventReceivedMs,
      result.measurements.toolRequestToToolStepCompletedEventReceivedMs,
      result.measurements.toolStepCompletedToFirstTextEventReceivedMs,
      result.measurements.firstTextEventReceivedToStopStepCompletedMs,
      result.measurements.stopStepCompletedToSessionWaitingEventReceivedMs,
    ]).not.toContain(null);
    expect(result.measurements).toMatchObject({
      firstTextEventReceivedToStopStepCompletedMs: 3,
      postAckMs: 1,
      postAckToSessionStartedEventReceivedMs: 1,
      sessionStartedToToolRequestEventReceivedMs: 6,
      sessionWaitingEventReceivedMs: 20,
      stopStepCompletedToSessionWaitingEventReceivedMs: 3,
      toolRequestToToolStepCompletedEventReceivedMs: 3,
      toolStepCompletedToFirstTextEventReceivedMs: 3,
    });
    expect(
      result.measurements.postAckMs +
        (result.measurements.postAckToSessionStartedEventReceivedMs ?? 0) +
        (result.measurements.sessionStartedToToolRequestEventReceivedMs ?? 0) +
        (result.measurements.toolRequestToToolStepCompletedEventReceivedMs ?? 0) +
        (result.measurements.toolStepCompletedToFirstTextEventReceivedMs ?? 0) +
        (result.measurements.firstTextEventReceivedToStopStepCompletedMs ?? 0) +
        (result.measurements.stopStepCompletedToSessionWaitingEventReceivedMs ?? 0),
    ).toBe(result.measurements.sessionWaitingEventReceivedMs);
    expect(seenHeaders).toEqual([SAMPLE_ID, SAMPLE_ID]);
    expect(seenAuthorizationHeaders).toEqual([
      `Bearer ${VERCEL_OIDC_TOKEN}`,
      `Bearer ${VERCEL_OIDC_TOKEN}`,
    ]);
    expect(seenRedirects).toEqual(["error", "error"]);
    expect(seenTrustedOidcHeaders).toEqual([VERCEL_OIDC_TOKEN, VERCEL_OIDC_TOKEN]);
    expect(JSON.stringify(result)).not.toContain(VERCEL_OIDC_TOKEN);
  });

  it("returns an invalid result when a completed transcript violates the contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, init) => {
        if (init?.method === "POST") {
          return Response.json({ continuationToken: "next-token", sessionId: "session-01" });
        }

        const body = `${createValidEvents()
          .map((event) => JSON.stringify(event))
          .join("\n")}\n`;
        return new Response(body);
      }),
    );

    const result = await runBenchmarkSample({
      nonce: "different-nonce",
      runtimeKind: "workflow",
      sampleId: SAMPLE_ID,
      targetKind: "local",
      targetUrl: "http://127.0.0.1:3100",
    });

    expect(result.outcome).toBe("invalid");
    if (result.outcome !== "invalid") return;
    expect(result.issues.map((issue) => issue.kind)).toEqual([
      "message-received-mismatch",
      "tool-request-mismatch",
      "final-visible-message",
    ]);
  });

  it.each([
    {
      event: {
        data: {
          code: "STEP_FAILED",
          message: "model step failed",
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-0",
        },
        type: "step.failed",
      },
      name: "step failure",
    },
    {
      event: {
        data: {
          code: "TURN_FAILED",
          message: "turn failed",
          sequence: 0,
          turnId: "turn-0",
        },
        type: "turn.failed",
      },
      name: "turn failure",
    },
    {
      event: {
        data: {
          code: "SESSION_FAILED",
          message: "session failed",
          sessionId: "session-01",
        },
        type: "session.failed",
      },
      name: "session failure",
    },
  ] satisfies ReadonlyArray<{ event: HandleMessageStreamEvent; name: string }>)(
    "returns a failed result for a streamed $name event",
    async ({ event }) => {
      mockEventStream(
        event.type === "session.failed"
          ? [event]
          : [event, { data: { wait: "next-user-message" }, type: "session.waiting" }],
      );

      const result = await runBenchmarkSample({
        nonce: TEST_NONCE,
        runtimeKind: "workflow",
        sampleId: SAMPLE_ID,
        targetKind: "local",
        targetUrl: "http://127.0.0.1:3100",
      });

      expect(result.outcome).toBe("failed");
      if (result.outcome !== "failed") return;
      expect(result.error).toMatchObject({
        message: event.data.message,
        name: event.data.code,
      });
    },
  );

  it("returns a failed result when the stream ends without a turn boundary", async () => {
    mockEventStream([]);

    const result = await runBenchmarkSample({
      nonce: TEST_NONCE,
      runtimeKind: "inline",
      sampleId: SAMPLE_ID,
      targetKind: "local",
      targetUrl: "http://127.0.0.1:3100",
    });

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.error).toEqual({
      message: "The event stream ended before a turn boundary was received.",
      name: "IncompleteBenchmarkStreamError",
    });
  });

  it("keeps a completed transcript with the wrong boundary in the invalid bucket", async () => {
    mockEventStream([...createValidEvents().slice(0, -1), { type: "session.completed" }]);

    const result = await runBenchmarkSample({
      nonce: TEST_NONCE,
      runtimeKind: "inline",
      sampleId: SAMPLE_ID,
      targetKind: "local",
      targetUrl: "http://127.0.0.1:3100",
    });

    expect(result.outcome).toBe("invalid");
    if (result.outcome !== "invalid") return;
    expect(result.issues.map((issue) => issue.kind)).toContain("session-waiting-count");
  });

  it("serializes transport failures instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("network unavailable");
      }),
    );

    const result = await runBenchmarkSample(
      {
        nonce: TEST_NONCE,
        runtimeKind: "temporal",
        sampleId: SAMPLE_ID,
        targetKind: "vercel",
        targetUrl: "https://temporal.sandbox.example",
      },
      { vercelOidcToken: VERCEL_OIDC_TOKEN },
    );

    expect(result.outcome).toBe("failed");
    if (result.outcome !== "failed") return;
    expect(result.error).toMatchObject({
      message: "network unavailable",
      name: "TypeError",
    });
    expect(result.measurements.postAckMs).toBeNull();
    expect(JSON.stringify(result)).not.toContain(VERCEL_OIDC_TOKEN);
  });
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function mockEventStream(events: readonly HandleMessageStreamEvent[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "POST") {
        return Response.json({ continuationToken: "next-token", sessionId: "session-01" });
      }

      const body =
        events.length === 0 ? "" : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
      return new Response(body);
    }),
  );
}
