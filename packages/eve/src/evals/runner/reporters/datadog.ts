import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";

/** Configuration for the Datadog LLM Observability reporter. */
export interface DatadogReporterConfig {
  /**
   * Datadog API key for agentless reporting. Overrides `DD_API_KEY` for this
   * process before the tracer initializes.
   */
  readonly apiKey?: string;
  /**
   * Datadog application key. Overrides `DD_APP_KEY` for this process before
   * the tracer initializes. LLM Observability ingestion uses the API key; an
   * application key is only needed by other Datadog APIs in the same process.
   */
  readonly appKey?: string;
  /**
   * Datadog LLM Observability project name. This is sent as the tracer's ML
   * application name and is used for both workflow spans and evaluations.
   */
  readonly projectName?: string;
  /**
   * Whether to send data directly to Datadog rather than through a Datadog
   * Agent. Defaults to `true`, which is suitable for CI.
   */
  readonly agentless?: boolean;
}

interface DatadogLlmObs {
  readonly enabled: boolean;
  trace<T>(
    options: {
      kind: "workflow";
      name: string;
      sessionId?: string;
      mlApp?: string;
    },
    fn: (span: unknown) => T,
  ): T;
  annotate(
    span: unknown,
    options: {
      inputData?: Record<string, unknown>;
      outputData?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      metrics?: Record<string, number>;
      tags?: Record<string, string>;
    },
  ): void;
  exportSpan(span: unknown): DatadogSpanContext;
  submitEvaluation(spanContext: DatadogSpanContext, options: DatadogEvaluationOptions): void;
  flush(): void | Promise<void>;
}

interface DatadogTracer {
  readonly llmobs: DatadogLlmObs;
  init(options: {
    llmobs: {
      agentlessEnabled: boolean;
      mlApp: string;
    };
  }): DatadogTracer;
}

interface ResolvedDatadogReporterConfig {
  readonly agentless: boolean;
  readonly apiKey?: string;
  readonly appKey?: string;
  readonly projectName: string;
}

interface DatadogSpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

interface DatadogEvaluationOptions {
  readonly label: string;
  readonly metricType: "score";
  readonly value: number;
  readonly tags?: Record<string, string>;
  readonly mlApp?: string;
  readonly timestampMs?: number;
  readonly assessment?: "pass" | "fail";
  readonly reasoning?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Creates an {@link EvalReporter} that sends eve evals to Datadog LLM
 * Observability. Each eval becomes a workflow span and each assertion becomes
 * a score evaluation attached to that span. Requires the optional `dd-trace`
 * peer package and enabled LLM Observability.
 */
export function Datadog(config: DatadogReporterConfig = {}): EvalReporter {
  return new DatadogReporter(config);
}

class DatadogReporter implements EvalReporter {
  readonly #config: DatadogReporterConfig;
  #llmobs: DatadogLlmObs | undefined;
  #projectName: string | undefined;
  #target: EveEvalTarget | undefined;
  readonly #evaluations = new Map<string, EveEval>();

  constructor(config: DatadogReporterConfig) {
    this.#config = config;
  }

  async onRunStart(evaluations: readonly EveEval[], target: EveEvalTarget): Promise<void> {
    const config = resolveDatadogReporterConfig(this.#config);
    configureDatadogEnvironment(config);

    const llmobs = await loadDatadogLlmObs(config);
    if (!llmobs.enabled) {
      throw new Error(
        [
          "Datadog LLM Observability is not enabled.",
          "",
          "Do not initialize 'dd-trace' separately before the reporter starts.",
        ].join("\n"),
      );
    }

    this.#llmobs = llmobs;
    this.#projectName = config.projectName;
    this.#target = target;
    this.#evaluations.clear();
    for (const evaluation of evaluations) {
      this.#evaluations.set(evaluation.id, evaluation);
    }
  }

  onEvalComplete(result: EveEvalResult): void | Promise<void> {
    const llmobs = this.#llmobs;
    const projectName = this.#projectName;
    if (!llmobs || !projectName) return;

    const evaluation = this.#evaluations.get(result.id);
    const target = this.#target;

    return llmobs.trace(
      {
        kind: "workflow",
        name: "eve.eval",
        sessionId: result.result.sessionId,
        mlApp: projectName,
      },
      (span) => {
        llmobs.annotate(span, resolveSpanAnnotation(result, evaluation, target));

        const spanContext = llmobs.exportSpan(span);
        const timestampMs = Date.parse(result.completedAt);
        for (const assertion of result.assertions) {
          llmobs.submitEvaluation(spanContext, {
            label: assertion.name,
            metricType: "score",
            value: assertion.score,
            assessment: assertion.passed ? "pass" : "fail",
            reasoning: assertion.message,
            tags: {
              ...resolveTags(result, target),
              eveAssertionSeverity: assertion.severity,
            },
            mlApp: projectName,
            ...(Number.isFinite(timestampMs) ? { timestampMs } : {}),
            metadata: {
              ...evaluation?.metadata,
              eveAssertionMetadata: assertion.metadata,
              eveAssertionSeverity: assertion.severity,
              eveAssertionThreshold: assertion.threshold,
              eveEvalId: result.id,
              eveVerdict: result.verdict,
            },
          });
        }
      },
    );
  }

  async onRunComplete(_summary: EveEvalRunSummary): Promise<void> {
    const llmobs = this.#llmobs;
    if (!llmobs) return;

    try {
      await llmobs.flush();
    } finally {
      this.#llmobs = undefined;
      this.#projectName = undefined;
      this.#target = undefined;
      this.#evaluations.clear();
    }
  }
}

const DATADOG_PACKAGE = "dd-trace";

async function loadDatadogLlmObs(config: ResolvedDatadogReporterConfig): Promise<DatadogLlmObs> {
  let sdk: unknown;
  try {
    sdk = await import(DATADOG_PACKAGE);
  } catch {
    throw new Error(
      [
        "The 'dd-trace' package is required for Datadog reporting but was not found.",
        "",
        "Install it with:",
        "  npm install dd-trace",
      ].join("\n"),
    );
  }

  const tracer = resolveDatadogTracer(sdk);
  if (!isDatadogTracer(tracer)) {
    throw new Error(
      "The installed 'dd-trace' package does not expose the Datadog LLM Observability SDK. Install a current version of 'dd-trace'.",
    );
  }

  tracer.init({
    llmobs: {
      agentlessEnabled: config.agentless,
      mlApp: config.projectName,
    },
  });

  return tracer.llmobs;
}

function resolveDatadogTracer(sdk: unknown): unknown {
  if (typeof sdk !== "object" || sdk === null) return undefined;

  const module = sdk as { default?: unknown };
  return module.default ?? module;
}

function isDatadogTracer(value: unknown): value is DatadogTracer {
  if (typeof value !== "object" || value === null) return false;

  const tracer = value as Partial<DatadogTracer>;
  return typeof tracer.init === "function" && isDatadogLlmObs(tracer.llmobs);
}

function isDatadogLlmObs(value: unknown): value is DatadogLlmObs {
  if (typeof value !== "object" || value === null) return false;

  const llmobs = value as Partial<DatadogLlmObs>;
  return (
    typeof llmobs.enabled === "boolean" &&
    typeof llmobs.trace === "function" &&
    typeof llmobs.annotate === "function" &&
    typeof llmobs.exportSpan === "function" &&
    typeof llmobs.submitEvaluation === "function" &&
    typeof llmobs.flush === "function"
  );
}

function resolveDatadogReporterConfig(
  config: DatadogReporterConfig,
): ResolvedDatadogReporterConfig {
  const agentless = config.agentless ?? true;
  const apiKey = config.apiKey || process.env.DD_API_KEY;
  const appKey = config.appKey || process.env.DD_APP_KEY;
  const projectName = config.projectName || process.env.DD_LLMOBS_ML_APP || process.env.DD_SERVICE;

  if (!projectName) {
    throw new Error(
      "Datadog reporting needs a project name. Set projectName, DD_LLMOBS_ML_APP, or DD_SERVICE.",
    );
  }

  if (agentless && !apiKey) {
    throw new Error(
      "Datadog agentless reporting needs an API key. Set apiKey or DD_API_KEY, or set agentless: false to use a Datadog Agent.",
    );
  }

  return { agentless, apiKey, appKey, projectName };
}

function configureDatadogEnvironment(config: ResolvedDatadogReporterConfig): void {
  if (config.apiKey) process.env.DD_API_KEY = config.apiKey;
  if (config.appKey) process.env.DD_APP_KEY = config.appKey;
}

function resolveSpanAnnotation(
  result: EveEvalResult,
  evaluation: EveEval | undefined,
  target: EveEvalTarget | undefined,
): {
  inputData: Record<string, unknown>;
  outputData: Record<string, unknown>;
  metadata: Record<string, unknown>;
  metrics: Record<string, number>;
  tags: Record<string, string>;
} {
  const failedAssertions = result.assertions
    .filter((assertion) => !assertion.passed)
    .map((assertion) => ({ name: assertion.name, message: assertion.message }));

  const metadata: Record<string, unknown> = {
    ...evaluation?.metadata,
    eveEvalId: result.id,
    eveEvalTags: evaluation?.tags,
    eveSessionId: result.result.sessionId,
    eveStatus: result.result.status,
    eveVerdict: result.verdict,
    eveSkipReason: result.skipReason,
    eveTargetUrl: target?.url,
    eveToolCalls: result.result.derived.toolCalls.map((call) => call.name),
    eveSubagentCalls: result.result.derived.subagentCalls.map((call) => call.name),
    eveParked: result.result.derived.parked,
  };

  if (failedAssertions.length > 0) {
    metadata.eveFailedAssertions = failedAssertions;
  }

  if (result.error) {
    metadata.eveError = result.error;
  }

  if (result.result.derived.failureCode) {
    metadata.eveFailureCode = result.result.derived.failureCode;
  }

  const metrics: Record<string, number> = {
    toolCallCount: result.result.derived.toolCallCount,
    subagentCallCount: result.result.derived.subagentCallCount,
    messageCount: result.result.derived.messageCount,
    reasoningBlockCount: result.result.derived.reasoningBlockCount,
  };
  const durationMs = Date.parse(result.completedAt) - Date.parse(result.startedAt);
  if (Number.isFinite(durationMs)) {
    metrics.durationMs = durationMs;
  }

  return {
    inputData: {
      description: evaluation?.description,
      id: result.id,
    },
    outputData: {
      error: result.error,
      output: result.result.output ?? null,
    },
    metadata,
    metrics,
    tags: resolveTags(result, target),
  };
}

function resolveTags(
  result: EveEvalResult,
  target: EveEvalTarget | undefined,
): Record<string, string> {
  return {
    eveEvalId: result.id,
    eveTargetKind: target?.kind ?? "unknown",
    eveVerdict: result.verdict,
  };
}
