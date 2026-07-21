import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Datadog, type DatadogReporterConfig } from "#evals/reporters/index.js";
import type { EveEval, EveEvalResult, EveEvalTarget } from "#evals/types.js";

const mocks = vi.hoisted(() => {
  const span = {};
  const llmobs = {
    enabled: true,
    annotate: vi.fn(),
    exportSpan: vi.fn(() => ({ spanId: "span-123", traceId: "trace-123" })),
    flush: vi.fn(),
    submitEvaluation: vi.fn(),
    trace: vi.fn((_options: unknown, fn: (activeSpan: object) => unknown) => fn(span)),
  };
  const tracer = {
    init: vi.fn(),
    llmobs,
  };
  tracer.init.mockReturnValue(tracer);

  return { llmobs, span, tracer };
});

vi.mock("dd-trace", () => ({ default: mocks.tracer, llmobs: mocks.llmobs }));

function makeTarget(kind: "local" | "remote" = "local"): EveEvalTarget {
  const url = kind === "local" ? "http://127.0.0.1:3000" : "https://test.vercel.app";
  return {
    capabilities: { devRoutes: kind === "local" },
    kind,
    url,
  };
}

function makeConfig(overrides: Partial<DatadogReporterConfig> = {}): DatadogReporterConfig {
  return {
    apiKey: "api-key",
    appKey: "app-key",
    projectName: "test-project",
    ...overrides,
  };
}

function makeEvaluation(): EveEval {
  return {
    _tag: "EveEval",
    description: "Checks the weather response.",
    id: "weather",
    metadata: { city: "Brooklyn" },
    tags: ["smoke"],
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
        toolCalls: [
          {
            name: "search",
            input: { query: "test" },
            output: null,
            status: "completed",
            turnIndex: 0,
            sessionId: "session-123",
          },
        ],
        toolCallCount: 1,
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
      { name: "similarity", score: 0.4, severity: "soft", threshold: 0.6, passed: false },
    ],
    verdict: "failed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DD_API_KEY", "");
  vi.stubEnv("DD_APP_KEY", "");
  vi.stubEnv("DD_LLMOBS_ML_APP", "");
  vi.stubEnv("DD_SERVICE", "");
  mocks.llmobs.enabled = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Datadog", () => {
  it("creates a reporter", () => {
    const reporter = Datadog(makeConfig());

    expect(reporter).toBeDefined();
    expect(reporter.onRunStart).toBeTypeOf("function");
    expect(reporter.onEvalComplete).toBeTypeOf("function");
    expect(reporter.onRunComplete).toBeTypeOf("function");
  });

  it("submits every assertion on an eval workflow span", async () => {
    const reporter = Datadog(makeConfig());
    const result = makeEvalResult();

    await reporter.onRunStart([makeEvaluation()], makeTarget());
    await reporter.onEvalComplete(result);
    await reporter.onRunComplete({
      target: makeTarget(),
      results: [result],
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      passed: 0,
      failed: 1,
      scored: 0,
      skipped: 0,
      errored: 0,
    });

    expect(mocks.llmobs.trace).toHaveBeenCalledWith(
      {
        kind: "workflow",
        name: "eve.eval",
        sessionId: "session-123",
        mlApp: "test-project",
      },
      expect.any(Function),
    );
    expect(mocks.tracer.init).toHaveBeenCalledWith({
      llmobs: {
        agentlessEnabled: true,
        mlApp: "test-project",
      },
    });
    expect(process.env.DD_API_KEY).toBe("api-key");
    expect(process.env.DD_APP_KEY).toBe("app-key");
    expect(mocks.llmobs.annotate).toHaveBeenCalledWith(
      mocks.span,
      expect.objectContaining({
        inputData: { description: "Checks the weather response.", id: "weather" },
        metrics: expect.objectContaining({ durationMs: 1_000, toolCallCount: 1 }),
        outputData: { error: undefined, output: "actual output" },
      }),
    );
    expect(mocks.llmobs.submitEvaluation).toHaveBeenNthCalledWith(
      1,
      { spanId: "span-123", traceId: "trace-123" },
      expect.objectContaining({
        assessment: "pass",
        label: "succeeded",
        mlApp: "test-project",
        metricType: "score",
        value: 1,
      }),
    );
    expect(mocks.llmobs.submitEvaluation).toHaveBeenNthCalledWith(
      2,
      { spanId: "span-123", traceId: "trace-123" },
      expect.objectContaining({
        assessment: "fail",
        label: "similarity",
        mlApp: "test-project",
        metricType: "score",
        value: 0.4,
      }),
    );
    expect(mocks.llmobs.flush).toHaveBeenCalledOnce();
  });

  it("requires Datadog LLM Observability to be enabled", async () => {
    mocks.llmobs.enabled = false;
    const reporter = Datadog(makeConfig());

    await expect(reporter.onRunStart([makeEvaluation()], makeTarget())).rejects.toThrow(
      "Datadog LLM Observability is not enabled.",
    );
  });

  it("uses DD_SERVICE as the project name when none is configured", async () => {
    vi.stubEnv("DD_API_KEY", "env-api-key");
    vi.stubEnv("DD_SERVICE", "evals-ci");
    const reporter = Datadog();
    const result = makeEvalResult();

    await reporter.onRunStart([makeEvaluation()], makeTarget());
    await reporter.onEvalComplete(result);

    expect(mocks.tracer.init).toHaveBeenCalledWith({
      llmobs: {
        agentlessEnabled: true,
        mlApp: "evals-ci",
      },
    });
    expect(mocks.llmobs.submitEvaluation).toHaveBeenCalledWith(
      { spanId: "span-123", traceId: "trace-123" },
      expect.objectContaining({ mlApp: "evals-ci" }),
    );
  });

  it("requires a project name and API key for agentless reporting", async () => {
    await expect(
      Datadog({ apiKey: "api-key" }).onRunStart([makeEvaluation()], makeTarget()),
    ).rejects.toThrow("Datadog reporting needs a project name.");
    await expect(
      Datadog({ projectName: "evals-ci" }).onRunStart([makeEvaluation()], makeTarget()),
    ).rejects.toThrow("Datadog agentless reporting needs an API key.");
  });

  it("is a no-op before the run starts", async () => {
    const reporter = Datadog(makeConfig());

    await reporter.onEvalComplete(makeEvalResult());
    await reporter.onRunComplete({
      target: makeTarget(),
      results: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      passed: 0,
      failed: 0,
      scored: 0,
      skipped: 0,
      errored: 0,
    });
  });
});
