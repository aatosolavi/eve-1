import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import type {
  DeliverInput,
  GetEventStreamOptions,
  HookPayload,
  RunHandle,
  RunInput,
  Runtime,
} from "#channel/types.js";
import { serializeContext } from "#context/serialize.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { RuntimeNoActiveSessionError } from "#execution/runtime-errors.js";
import { buildRunContext } from "#execution/runtime-context.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { parseLoopBenchmarkDeliveryMessage } from "#internal/loop-benchmark/delivery-message.js";
import { getRun, resumeHook, start, type WorkflowMetadata } from "#internal/workflow/runtime.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

import type { WorkflowBenchmarkSessionInput } from "./contracts.js";

const EVE_PACKAGE_INFO = resolveInstalledPackageInfo();
const WORKFLOW_BENCHMARK_SESSION_REFERENCE = {
  workflowId: `workflow//${EVE_PACKAGE_INFO.name}@${EVE_PACKAGE_INFO.version}//workflowBenchmarkSession`,
} satisfies WorkflowMetadata;

export interface WorkflowBenchmarkRuntimeConfig {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}

/** Creates the independently orchestrated Workflow DevKit loop runtime. */
export function createWorkflowBenchmarkRuntime(config: WorkflowBenchmarkRuntimeConfig): Runtime {
  return {
    async run(input: RunInput): Promise<RunHandle> {
      const message = parseInitialMessage(input);
      const continuationToken =
        input.continuationToken ?? `workflow-benchmark:${crypto.randomUUID()}`;

      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: config.compiledArtifactsSource,
        nodeId: config.nodeId,
      });
      const context = buildRunContext({
        bundle,
        run: { ...input, continuationToken },
      });
      const workflowInput: WorkflowBenchmarkSessionInput = {
        compiledArtifactsSource: config.compiledArtifactsSource,
        continuationToken,
        initialDelivery: {
          kind: "deliver",
          payloads: [{ message }],
          requestId: input.requestId,
        },
        nodeId: config.nodeId,
        serializedContext: serializeContext(context),
      };
      const run = await start(WORKFLOW_BENCHMARK_SESSION_REFERENCE, [workflowInput]);

      let events: ReadableStream<HandleMessageStreamEvent> | undefined;
      return {
        continuationToken,
        get events() {
          events ??= parseNdjsonStream<HandleMessageStreamEvent>(() =>
            getRun(run.runId).getReadable(),
          );
          return events;
        },
        sessionId: run.runId,
      };
    },

    async deliver(input: DeliverInput): Promise<{ readonly sessionId: string }> {
      parseLoopBenchmarkDeliveryMessage(input, "Workflow");
      const payload: Extract<HookPayload, { readonly kind: "deliver" }> = {
        auth: input.auth,
        kind: "deliver",
        payloads: [input.payload],
        requestId: input.requestId,
      };

      try {
        const resumed = await resumeHook(input.continuationToken, payload);
        return { sessionId: readRunId(resumed) };
      } catch (error) {
        if (HookNotFoundError.is(error)) {
          throw new RuntimeNoActiveSessionError(input.continuationToken);
        }
        throw error;
      }
    },

    async getEventStream(
      sessionId: string,
      options?: GetEventStreamOptions,
    ): Promise<ReadableStream<HandleMessageStreamEvent>> {
      return parseNdjsonStream<HandleMessageStreamEvent>(() =>
        getRun(sessionId).getReadable({ startIndex: options?.startIndex }),
      );
    },
  };
}

function parseInitialMessage(input: RunInput): string {
  if (input.mode !== "conversation") {
    throw new Error('Workflow benchmark only supports mode "conversation".');
  }
  if (typeof input.input.message !== "string") {
    throw new Error("Workflow benchmark only supports plain-text messages.");
  }
  if (input.input.message.trim().length === 0) {
    throw new Error("Workflow benchmark requires a non-empty message.");
  }
  if (input.input.context !== undefined || input.input.outputSchema !== undefined) {
    throw new Error("Workflow benchmark does not support context or output schemas.");
  }
  if (
    input.callback !== undefined ||
    input.parent !== undefined ||
    input.subagentDepth !== undefined ||
    input.subagentMaxDepth !== undefined
  ) {
    throw new Error("Workflow benchmark does not support callbacks or delegated sessions.");
  }
  return input.input.message;
}

function readRunId(value: unknown): string {
  if (typeof value !== "object" || value === null || !("runId" in value)) {
    throw new Error("Workflow benchmark hook did not include a run id.");
  }
  const runId = value.runId;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Workflow benchmark hook did not include a run id.");
  }
  return runId;
}
