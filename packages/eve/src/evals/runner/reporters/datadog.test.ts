import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Datadog, type DatadogReporterConfig } from "#evals/reporters/index.js";
import type { EveEval, EveEvalResult, EveEvalTarget } from "#evals/types.js";

const fetchMock = vi.fn();

function makeTarget(): EveEvalTarget {
  return {
    capabilities: { devRoutes: true },
    kind: "local",
    url: "http://127.0.0.1:3000",
  };
}

function makeConfig(overrides: Partial<DatadogReporterConfig> = {}): DatadogReporterConfig {
  return {
    apiKey: "api-key",
    projectName: "test-project",
    resolveTraceContext: () => ({
      spanId: "00000000000000ff",
      traceId: "0123456789abcdef0123456789abcdef",
    }),
    ...overrides,
  };
}

function makeEvaluation(): EveEval {
  return {
    _tag: "EveEval",
    id: "weather",
    test() {},
  };
}

function makeEvalResult(overrides: Partial<EveEvalResult> = {}): EveEvalResult {
  return {
    id: "weather",
    result: {
      output: "actual output",
      finalMessage: "actual output",
      status: "completed",
      events: [],
      derived: {
        toolCalls: [],
        toolCallCount: 0,
        subagentCalls: [],
        subagentCallCount: 0,
        inputRequests: [],
        parked: false,
        messageCount: 1,
        reasoningBlockCount: 0,
      },
      sessionId: "session-123",
    },
    assertions: [
      { name: "succeeded", score: 1, severity: "gate", passed: true },
      {
        name: "similarity score",
        score: 0.4,
        severity: "soft",
        threshold: 0.6,
        passed: false,
        message: "Response was too dissimilar.",
      },
    ],
    verdict: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Datadog", () => {
  it("creates a reporter", () => {
    const reporter = Datadog(makeConfig());

    expect(reporter).toBeDefined();
    expect(reporter.onRunStart).toBeTypeOf("function");
    expect(reporter.onEvalComplete).toBeTypeOf("function");
    expect(reporter.onRunComplete).toBeTypeOf("function");
  });

  it("attaches every assertion to the resolved OTel runtime span", async () => {
    const resolveTraceContext = vi.fn(makeConfig().resolveTraceContext);
    const reporter = Datadog(makeConfig({ resolveTraceContext }));
    const result = makeEvalResult();

    await reporter.onRunStart([makeEvaluation()], makeTarget());
    await reporter.onEvalComplete(result);

    expect(resolveTraceContext).toHaveBeenCalledWith("session-123");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.datadoghq.com/api/intake/llm-obs/v2/eval-metric",
      expect.objectContaining({
        headers: {
          "content-type": "application/json",
          "DD-API-KEY": "api-key",
        },
        method: "POST",
      }),
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      data: {
        type: "evaluation_metric",
        attributes: {
          metrics: [
            expect.objectContaining({
              assessment: "pass",
              join_on: {
                span: {
                  span_id: "255",
                  trace_id: "0123456789abcdef0123456789abcdef",
                },
              },
              label: "succeeded",
              metric_type: "score",
              ml_app: "test-project",
              score_value: 1,
              tags: expect.arrayContaining(["source:otel", "eve_eval_id:weather"]),
              timestamp_ms: 1_767_225_601_000,
            }),
            expect.objectContaining({
              assessment: "fail",
              label: "similarity_score",
              reasoning: "Response was too dissimilar.",
              score_value: 0.4,
            }),
          ],
        },
      },
    });
  });

  it("requires a trace context for the primary eval session", async () => {
    const reporter = Datadog(makeConfig({ resolveTraceContext: () => undefined }));

    await reporter.onRunStart([makeEvaluation()], makeTarget());
    await expect(reporter.onEvalComplete(makeEvalResult())).rejects.toThrow(
      'could not resolve an OTel trace context for eval "weather" session "session-123"',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the OTel trace context", async () => {
    const reporter = Datadog(
      makeConfig({
        resolveTraceContext: () => ({ spanId: "not-a-span-id", traceId: "not-a-trace-id" }),
      }),
    );

    await reporter.onRunStart([makeEvaluation()], makeTarget());
    await expect(reporter.onEvalComplete(makeEvalResult())).rejects.toThrow(
      "Datadog reporting needs a 32-character hexadecimal OTel trace ID.",
    );
  });

  it("surfaces Datadog intake failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Unknown span", { status: 404 }));
    const reporter = Datadog(makeConfig());

    await reporter.onRunStart([makeEvaluation()], makeTarget());
    await expect(reporter.onEvalComplete(makeEvalResult())).rejects.toThrow(
      "Datadog evaluation intake failed (404): Unknown span",
    );
  });

  it("requires explicit projectName, apiKey, and trace-context resolver", () => {
    expect(() =>
      Datadog(makeConfig({ projectName: "" })).onRunStart([makeEvaluation()], makeTarget()),
    ).toThrow("Datadog reporting needs a projectName.");
    expect(() =>
      Datadog(makeConfig({ apiKey: "" })).onRunStart([makeEvaluation()], makeTarget()),
    ).toThrow("Datadog reporting needs an apiKey.");
    expect(() =>
      Datadog({
        apiKey: "api-key",
        projectName: "test-project",
      } as DatadogReporterConfig).onRunStart([makeEvaluation()], makeTarget()),
    ).toThrow("Datadog reporting needs a resolveTraceContext function.");
  });

  it("is a no-op before the run starts", async () => {
    const reporter = Datadog(makeConfig());

    await reporter.onEvalComplete(makeEvalResult());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
