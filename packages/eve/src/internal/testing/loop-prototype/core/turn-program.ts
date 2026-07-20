import { operationId } from "./ids.js";
import { writeEvent } from "./program-support.js";
import { appendUser } from "./transcript.js";
import { next, resolveApproval, TurnEffectExhaustedError } from "./turn-step.js";
import type { LoopBackend, TerminalOutcome, TurnOutcome, TurnProgramInput } from "./types.js";

export async function runTurn(backend: LoopBackend, input: TurnProgramInput): Promise<TurnOutcome> {
  let state = input.state;

  try {
    if (input.delivery.kind === "message") {
      if (state.pending !== null) {
        throw new Error("A message delivery cannot resolve a pending approval.");
      }
      state = { ...state, history: appendUser(state.history, input.delivery.message) };
    } else {
      state = await resolveApproval(backend, state, input.delivery);
    }

    let stepOrdinal = 0;
    while (true) {
      const step = await next(backend, { state, stepOrdinal: stepOrdinal++ });
      state = step.state;
      if (!step.done) continue;

      state = { ...state, phase: step.kind === "terminal" ? "terminal" : "between-turns" };
      await backend.checkpoint(state);

      if (step.kind === "waiting-approval") {
        return { kind: "waiting-approval", requestId: step.requestId, state };
      }
      if (step.kind === "terminal") {
        return { kind: "task-terminal", state, terminal: step.terminal };
      }
      return { kind: "conversation-replied", output: step.output, state };
    }
  } catch (error) {
    if (!(error instanceof TurnEffectExhaustedError)) throw error;
    const terminal: Extract<TerminalOutcome, { readonly kind: "failed" }> = {
      error: error.effectError.failure,
      kind: "failed",
    };
    const failedState = { ...error.state, phase: "terminal" } as const;
    await writeEvent(
      backend,
      operationId(error.state.sessionId, error.state.nextTurnOrdinal - 1, "turn-failed"),
      {
        code: terminal.error.code,
        message: terminal.error.message,
        type: "turn.failed",
      },
    );
    await backend.checkpoint(failedState);
    return { kind: "task-terminal", state: failedState, terminal };
  }
}
