import { Context } from "@temporalio/activity";

import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createSessionOperation } from "#execution/session-operation.js";
import type { DurableSessionState } from "#execution/durable-session-state.js";
import {
  executeTurnStepOperation,
  type DurableStepResult,
} from "#execution/turn-step-operation.js";
import type { LoopBenchmarkRecorder } from "#internal/loop-benchmark/recorder.js";
import {
  createLoopBenchmarkRecorder,
  recordLoopBenchmarkInterval,
  scheduleLoopBenchmarkRecorderFlush,
} from "#internal/loop-benchmark/runtime-telemetry.js";
import type { TemporalBenchmarkActivities, TemporalBenchmarkTurnStepInput } from "./contracts.js";
import { LocalTemporalBenchmarkService } from "./service.js";

/** Binds the production eve operations to Temporal Activity boundaries. */
export function createTemporalBenchmarkActivities(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId?: string;
  readonly service: LocalTemporalBenchmarkService;
}): TemporalBenchmarkActivities {
  return {
    async createSession(activityInput): Promise<{ readonly state: DurableSessionState }> {
      const recorder = createActivityRecorder({
        activityName: "create-session",
        sampleId: activityInput.sampleId,
      });
      try {
        const result = await recordLoopBenchmarkInterval(
          recorder,
          "session.create.operation",
          async () =>
            await createSessionOperation({
              compiledArtifactsSource: input.compiledArtifactsSource,
              continuationToken: activityInput.continuationToken,
              nodeId: input.nodeId,
              sessionId: activityInput.sessionId,
            }),
        );
        scheduleLoopBenchmarkRecorderFlush(recorder);
        return result;
      } catch (error) {
        input.service.fail(activityInput.sessionId, error);
        scheduleLoopBenchmarkRecorderFlush(recorder);
        throw error;
      }
    },

    async executeTurnStep(activityInput): Promise<DurableStepResult> {
      const recorder = createActivityRecorder({
        activityName: "turn-step",
        sampleId: activityInput.sampleId,
      });
      try {
        const durableSession = requireSnapshot(activityInput.sessionState);
        const result = await recordLoopBenchmarkInterval(
          recorder,
          "turn.step.operation",
          async () =>
            await executeTurnStepOperation({
              createEventSink() {
                return {
                  async write(publication): Promise<void> {
                    const append = async () => {
                      input.service.appendEvent(activityInput.sessionId, {
                        encoded: publication.encoded,
                        event: publication.event,
                        publicationKey: createPublicationKey(
                          activityInput,
                          publication.emissionOrdinal,
                        ),
                      });
                    };
                    if (recorder === undefined) {
                      await append();
                    } else {
                      await recordLoopBenchmarkInterval(recorder, "event.publish", append);
                    }
                    const observation = {
                      encodedBytes: publication.encoded.byteLength,
                      eventType: publication.event.type,
                      metaAt: publication.event.meta.at,
                      ordinal: publication.emissionOrdinal,
                    };
                    recorder?.observeEvent({ ...observation, stage: "publish.ack" });
                  },
                };
              },
              durableSession,
              input: activityInput.input,
              serializedContext: activityInput.serializedContext,
              sessionState: activityInput.sessionState,
            }),
        );

        scheduleLoopBenchmarkRecorderFlush(recorder);
        return result;
      } catch (error) {
        input.service.fail(activityInput.sessionId, error);
        scheduleLoopBenchmarkRecorderFlush(recorder);
        throw error;
      }
    },

    async rekeySession(activityInput): Promise<void> {
      const recorder = createActivityRecorder({
        activityName: "rekey-session",
        sampleId: activityInput.sampleId,
      });
      try {
        await recordLoopBenchmarkInterval(recorder, "session.rekey", async () => {
          input.service.rekey(activityInput);
        });
        recorder?.mark("session.rekey.accepted");
        recorder?.mark("runtime.park.accepted");
        scheduleLoopBenchmarkRecorderFlush(recorder);
      } catch (error) {
        input.service.fail(activityInput.sessionId, error);
        scheduleLoopBenchmarkRecorderFlush(recorder);
        throw error;
      }
    },

    async settleSession(activityInput): Promise<void> {
      const recorder = createActivityRecorder({
        activityName: "settle-session",
        sampleId: activityInput.sampleId,
      });
      try {
        await recordLoopBenchmarkInterval(recorder, "session.settle", async () => {
          input.service.settle(activityInput.sessionId);
        });
        recorder?.mark("session.settle.accepted");
        scheduleLoopBenchmarkRecorderFlush(recorder);
      } catch (error) {
        input.service.fail(activityInput.sessionId, error);
        scheduleLoopBenchmarkRecorderFlush(recorder);
        throw error;
      }
    },
  };
}

function createActivityRecorder(input: {
  readonly activityName: string;
  readonly sampleId: string | undefined;
}): LoopBenchmarkRecorder | undefined {
  const info = Context.current().info;
  const execution = info.workflowExecution;
  if (execution === undefined) {
    throw new Error(
      `Temporal benchmark Activity "${input.activityName}" has no Workflow execution.`,
    );
  }
  const recorder = createLoopBenchmarkRecorder({
    actor: "worker",
    attempt: `${execution.workflowId}:${info.activityId}:attempt:${String(info.attempt)}`,
    hostRole: "worker",
    runtime: "temporal",
    sampleId: input.sampleId,
  });
  recorder?.engine({
    activityId: info.activityId,
    attempt: info.attempt,
    kind: "temporal.activity",
    runId: execution.runId,
    workflowId: execution.workflowId,
  });
  return recorder;
}

function requireSnapshot(
  state: DurableSessionState,
): NonNullable<DurableSessionState["snapshot"]>["session"] {
  if (state.snapshot === undefined) {
    throw new Error("Temporal benchmark requires an embedded durable session snapshot.");
  }
  return state.snapshot.session;
}

function createPublicationKey(
  input: TemporalBenchmarkTurnStepInput,
  emissionOrdinal: number,
): string {
  return [
    input.sessionId,
    "turn",
    String(input.turnOrdinal),
    "step",
    String(input.stepOrdinal),
    "event",
    String(emissionOrdinal),
  ].join(":");
}
