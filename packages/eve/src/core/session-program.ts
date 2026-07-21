import type { Delivery, LoopBackend, SessionProgramInput, TerminalOutcome } from "#core/types.js";

/**
 * Drives one session: dispatch a turn per delivery until a turn completes
 * the session, then publish the terminal outcome exactly once through
 * `finish`. A waiting or cancelled turn parks the session; the next
 * delivery arrives through `receive`, which owns buffering, coalescing,
 * and descendant routing below the port.
 */
export async function runSession(
  backend: LoopBackend,
  input: SessionProgramInput,
): Promise<TerminalOutcome> {
  let state = input.state;
  let delivery: Delivery | undefined = input.initialDelivery;

  while (true) {
    const received = delivery ?? (await backend.receive(state));
    delivery = undefined;

    const turn = await backend
      .spawnTurn({
        capabilities: input.capabilities,
        delivery: received,
        mode: input.mode,
        state,
      })
      .wait();
    state = turn.state;

    if (turn.kind === "done") {
      const outcome: TerminalOutcome = {
        isError: turn.isError,
        output: turn.output,
        usage: turn.usage,
      };
      await backend.finish(outcome);
      return outcome;
    }
  }
}
