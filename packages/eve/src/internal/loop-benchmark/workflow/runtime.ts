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
import type { LoopBenchmarkRecorder } from "#internal/loop-benchmark/recorder.js";
import {
  createLoopBenchmarkRecorder,
  recordLoopBenchmarkInterval,
  scheduleLoopBenchmarkRecorderFlush,
} from "#internal/loop-benchmark/runtime-telemetry.js";
import { getRun, resumeHook, start } from "#internal/workflow/runtime.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

import type { WorkflowBenchmarkSessionInput } from "./contracts.js";
import { workflowBenchmarkSession } from "./workflows.js";

export interface WorkflowBenchmarkRuntimeConfig {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
}

/** Creates the independently orchestrated Workflow DevKit benchmark runtime. */
export function createWorkflowBenchmarkRuntime(config: WorkflowBenchmarkRuntimeConfig): Runtime {
  return {
    async run(input: RunInput): Promise<RunHandle> {
      const message = parseInitialMessage(input);
      const continuationToken =
        input.continuationToken ?? `workflow-benchmark:${crypto.randomUUID()}`;
      const recorder = createControllerRecorder({
        attempt: `${input.requestId ?? continuationToken}:run`,
        sampleId: input.requestId,
      });

      try {
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
          sampleId: input.requestId,
          serializedContext: serializeContext(context),
        };
        const run = await recordLoopBenchmarkInterval(
          recorder,
          "engine.dispatch",
          async () => await start(workflowBenchmarkSession, [workflowInput]),
        );
        recorder?.engine({ kind: "workflow.run", workflowRunId: run.runId });
        scheduleLoopBenchmarkRecorderFlush(recorder);

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
      } catch (error) {
        scheduleLoopBenchmarkRecorderFlush(recorder);
        throw error;
      }
    },

    async deliver(input: DeliverInput): Promise<{ readonly sessionId: string }> {
      parseDeliveryMessage(input);
      const recorder = createControllerRecorder({
        attempt: `${input.requestId ?? input.continuationToken}:deliver`,
        sampleId: input.requestId,
      });
      const payload: Extract<HookPayload, { readonly kind: "deliver" }> = {
        auth: input.auth,
        kind: "deliver",
        payloads: [input.payload],
        requestId: input.requestId,
      };

      try {
        const resumed = await recordLoopBenchmarkInterval(recorder, "engine.signal", async () =>
          resumeHook(input.continuationToken, payload),
        );
        scheduleLoopBenchmarkRecorderFlush(recorder);
        return { sessionId: readRunId(resumed) };
      } catch (error) {
        scheduleLoopBenchmarkRecorderFlush(recorder);
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

function createControllerRecorder(input: {
  readonly attempt: string;
  readonly sampleId: string | undefined;
}): LoopBenchmarkRecorder | undefined {
  return createLoopBenchmarkRecorder({
    actor: "controller",
    attempt: input.attempt,
    hostRole: "controller",
    runtime: "workflow",
    sampleId: input.sampleId,
  });
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

function parseDeliveryMessage(input: DeliverInput): string {
  const keys = Object.keys(input.payload).filter((key) => key !== "message");
  if (keys.length > 0 || typeof input.payload.message !== "string") {
    throw new Error("Workflow benchmark only supports plain-text follow-up deliveries.");
  }
  if (input.payload.message.trim().length === 0) {
    throw new Error("Workflow benchmark requires a non-empty follow-up message.");
  }
  return input.payload.message;
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
