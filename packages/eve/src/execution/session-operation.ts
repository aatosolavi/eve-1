import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  createDurableSessionState,
  type DurableSessionState,
} from "#execution/durable-session-state.js";
import { createSession } from "#execution/session.js";
import type { JsonObject } from "#shared/json.js";

/** Input for creating one initial durable session state. */
export interface CreateSessionOperationInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly continuationToken: string;
  readonly outputSchema?: JsonObject;
  readonly nodeId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly subagentDepth?: number;
  readonly subagentMaxDepth?: number;
}

/** Initial snapshot-bearing state returned to a runtime's session program. */
export interface CreateSessionOperationResult {
  readonly state: DurableSessionState;
}

/** Creates the initial durable session state without imposing a runtime boundary. */
export async function createSessionOperation(
  input: CreateSessionOperationInput,
): Promise<CreateSessionOperationResult> {
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: input.compiledArtifactsSource,
    nodeId: input.nodeId,
  });

  const session = createSession({
    compactionOverrides: {
      thresholdPercent: bundle.resolvedAgent.config.compaction?.thresholdPercent,
    },
    continuationToken: input.continuationToken,
    limits: {
      maxInputTokensPerSession: bundle.resolvedAgent.config.limits?.maxInputTokensPerSession,
      maxOutputTokensPerSession: bundle.resolvedAgent.config.limits?.maxOutputTokensPerSession,
    },
    outputSchema: input.outputSchema,
    rootSessionId: input.rootSessionId,
    sessionId: input.sessionId,
    subagentDepth: input.subagentDepth,
    subagentMaxDepth:
      input.subagentMaxDepth ?? bundle.resolvedAgent.config.limits?.maxSubagentDepth,
    turnAgent: bundle.turnAgent,
  });

  return { state: createDurableSessionState({ session }) };
}
