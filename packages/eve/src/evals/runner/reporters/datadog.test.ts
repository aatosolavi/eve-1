import { beforeEach, describe, expect, it, vi } from "vitest";
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

  return { llmobs, span };
});

vi.mock("dd-trace", () => ({ default: { llmobs: mocks.llmobs }, llmobs: mocks.llmobs }));

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
    mlApp: "test-app",
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
  mocks.llmobs.enabled = true;
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
        mlApp: "test-app",
      },
      expect.any(Function),
    );
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
