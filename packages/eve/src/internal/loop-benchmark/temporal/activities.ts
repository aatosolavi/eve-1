import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createSessionOperation } from "#execution/session-operation.js";
import type { DurableSessionState } from "#execution/durable-session-state.js";
import {
  executeTurnStepOperation,
  type DurableStepResult,
} from "#execution/turn-step-operation.js";
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
      try {
        return await createSessionOperation({
          compiledArtifactsSource: input.compiledArtifactsSource,
          continuationToken: activityInput.continuationToken,
          nodeId: input.nodeId,
          sessionId: activityInput.sessionId,
        });
      } catch (error) {
        input.service.fail(activityInput.sessionId, error);
        throw error;
      }
    },

    async executeTurnStep(activityInput): Promise<DurableStepResult> {
      try {
        const durableSession = requireSnapshot(activityInput.sessionState);
        return await executeTurnStepOperation({
          createEventSink() {
            return {
              async write(publication): Promise<void> {
                input.service.appendEvent(activityInput.sessionId, {
                  encoded: publication.encoded,
                  event: publication.event,
                  publicationKey: createPublicationKey(activityInput, publication.emissionOrdinal),
                });
              },
            };
          },
          durableSession,
          input: activityInput.input,
          serializedContext: activityInput.serializedContext,
          sessionState: activityInput.sessionState,
          writeEveAttributes: undefined,
        });
      } catch (error) {
        input.service.fail(activityInput.sessionId, error);
        throw error;
      }
    },

    async rekeySession(activityInput): Promise<void> {
      try {
        input.service.rekey(activityInput);
      } catch (error) {
        input.service.fail(activityInput.sessionId, error);
        throw error;
      }
    },

    async settleSession(activityInput): Promise<void> {
      try {
        input.service.settle(activityInput.sessionId);
      } catch (error) {
        input.service.fail(activityInput.sessionId, error);
        throw error;
      }
    },
  };
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
