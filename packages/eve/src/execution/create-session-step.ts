import {
  createSessionOperation,
  type CreateSessionOperationInput,
  type CreateSessionOperationResult,
} from "#execution/session-operation.js";

/**
 * Result returned by {@link createSessionStep}.
 *
 * Exposes the projected durable session state the driver needs to drive
 * the turn loop.
 */
export interface CreateSessionStepResult {
  readonly state: CreateSessionOperationResult["state"];
}

/**
 * Creates the durable session and returns the initial snapshot-bearing
 * state before the workflow enters its turn loop.
 * `nodeId` targets a subagent node in the compiled graph; omitted for
 * the root agent.
 */
export async function createSessionStep(
  input: CreateSessionOperationInput,
): Promise<CreateSessionStepResult> {
  "use step";

  return await createSessionOperation(input);
}
