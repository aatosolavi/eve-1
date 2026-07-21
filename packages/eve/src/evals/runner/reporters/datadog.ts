import type { EveEval, EveEvalResult, EveEvalRunSummary, EveEvalTarget } from "#evals/types.js";
import type { EvalReporter } from "#evals/runner/reporters/types.js";

/** OTel span identity for the runtime span an eval assesses. */
export interface DatadogOtelTraceContext {
  /** The 32-character hexadecimal OpenTelemetry trace ID. */
  readonly traceId: string;
  /** The 16-character hexadecimal OpenTelemetry span ID. */
  readonly spanId: string;
}

/** Configuration for the Datadog LLM Observability reporter. */
export interface DatadogReporterConfig {
  /** Datadog API key used for evaluation intake. */
  readonly apiKey: string;
  /** Datadog LLM Observability ML application name. */
  readonly projectName: string;
  /**
   * Resolves the OTel runtime span that received a primary eval session.
   *
   * The reporter attaches each assertion directly to this span instead of
   * creating a synthetic eval trace.
   */
  readonly resolveTraceContext: (
    sessionId: string,
  ) => DatadogOtelTraceContext | undefined | Promise<DatadogOtelTraceContext | undefined>;
  /** Datadog site domain, such as `datadoghq.com`. */
  readonly site?: string;
}

interface ResolvedDatadogReporterConfig extends DatadogReporterConfig {
  readonly site: string;
}

/**
 * Creates an {@link EvalReporter} that submits each assertion as a Datadog
 * evaluation attached to the eval's runtime OpenTelemetry span.
 */
export function Datadog(config: DatadogReporterConfig): EvalReporter {
  return new DatadogReporter(config);
}

class DatadogReporter implements EvalReporter {
  readonly #config: DatadogReporterConfig;
  #resolvedConfig: ResolvedDatadogReporterConfig | undefined;

  constructor(config: DatadogReporterConfig) {
    this.#config = config;
  }

  onRunStart(_evaluations: readonly EveEval[], _target: EveEvalTarget): void {
    this.#resolvedConfig = resolveDatadogReporterConfig(this.#config);
  }

  async onEvalComplete(result: EveEvalResult): Promise<void> {
    const config = this.#resolvedConfig;
    if (config === undefined || result.assertions.length === 0) return;

    const sessionId = result.result.sessionId;
    if (sessionId === undefined) {
      throw new Error(`Datadog reporting needs a primary session for eval "${result.id}".`);
    }

    const traceContext = await config.resolveTraceContext(sessionId);
    if (traceContext === undefined) {
      throw new Error(
        `Datadog reporting could not resolve an OTel trace context for eval "${result.id}" session "${sessionId}".`,
      );
    }

    await submitEvaluations({ config, result, traceContext: normalizeTraceContext(traceContext) });
  }

  onRunComplete(_summary: EveEvalRunSummary): void {
    this.#resolvedConfig = undefined;
  }
}

function resolveDatadogReporterConfig(
  config: DatadogReporterConfig,
): ResolvedDatadogReporterConfig {
  if (!config.projectName) {
    throw new Error("Datadog reporting needs a projectName.");
  }

  if (!config.apiKey) {
    throw new Error("Datadog reporting needs an apiKey.");
  }

  if (typeof config.resolveTraceContext !== "function") {
    throw new Error("Datadog reporting needs a resolveTraceContext function.");
  }

  const site = config.site?.trim() || "datadoghq.com";
  return { ...config, site };
}

async function submitEvaluations(input: {
  readonly config: ResolvedDatadogReporterConfig;
  readonly result: EveEvalResult;
  readonly traceContext: DatadogOtelTraceContext;
}): Promise<void> {
  const timestampMs = Date.parse(input.result.completedAt);
  const response = await fetch(
    `https://api.${input.config.site}/api/intake/llm-obs/v2/eval-metric`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "DD-API-KEY": input.config.apiKey,
      },
      body: JSON.stringify({
        data: {
          type: "evaluation_metric",
          attributes: {
            metrics: input.result.assertions.map((assertion) => ({
              join_on: {
                span: {
                  span_id: input.traceContext.spanId,
                  trace_id: input.traceContext.traceId,
                },
              },
              ml_app: input.config.projectName,
              timestamp_ms: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
              metric_type: "score",
              label: normalizeLabel(assertion.name),
              score_value: assertion.score,
              assessment: assertion.passed ? "pass" : "fail",
              reasoning: assertion.message,
              tags: [
                "source:otel",
                `eve_eval_id:${input.result.id}`,
                `eve_assertion_severity:${assertion.severity}`,
                `eve_verdict:${input.result.verdict}`,
              ],
            })),
          },
        },
      }),
    },
  );

  if (response.ok) return;

  const detail = (await response.text()).trim();
  throw new Error(
    `Datadog evaluation intake failed (${response.status})${detail.length > 0 ? `: ${detail}` : "."}`,
  );
}

function normalizeTraceContext(input: DatadogOtelTraceContext): DatadogOtelTraceContext {
  const traceId = input.traceId.toLowerCase();
  const spanId = input.spanId.toLowerCase();

  if (!/^[0-9a-f]{32}$/.test(traceId)) {
    throw new Error("Datadog reporting needs a 32-character hexadecimal OTel trace ID.");
  }

  if (!/^[0-9a-f]{16}$/.test(spanId)) {
    throw new Error("Datadog reporting needs a 16-character hexadecimal OTel span ID.");
  }

  return {
    traceId,
    spanId: BigInt(`0x${spanId}`).toString(),
  };
}

function normalizeLabel(label: string): string {
  const normalized = label.replace(/[^A-Za-z0-9_]/g, "_");
  const withPrefix = /^[A-Za-z]/.test(normalized) ? normalized : `assertion_${normalized}`;
  return withPrefix.slice(0, 200);
}
