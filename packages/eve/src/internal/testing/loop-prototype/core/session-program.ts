import { emptyHistory } from "./transcript.js";
import type {
  Delivery,
  LoopBackend,
  MessageDelivery,
  OpenExchange,
  SessionProgramInput,
  SessionState,
  TerminalOutcome,
} from "./types.js";

export async function runSession(
  backend: LoopBackend,
  input: SessionProgramInput,
): Promise<TerminalOutcome> {
  let state: SessionState = {
    bufferedDeliveries: [],
    history: emptyHistory(),
    mode: input.mode,
    nextTurnOrdinal: 0,
    pending: null,
    phase: "between-turns",
    scenario: input.scenario,
    sessionId: input.sessionId,
  };
  await backend.checkpoint(state);

  let initialDelivery: MessageDelivery | null = input.initialDelivery;

  while (true) {
    const deliveryResult = await nextDelivery(backend, state, initialDelivery);
    state = deliveryResult.state;
    initialDelivery = null;

    const turnState: SessionState = {
      ...state,
      nextTurnOrdinal: state.nextTurnOrdinal + 1,
      phase: "turn",
    };
    await backend.checkpoint(turnState);

    const turn = await backend
      .spawnTurn({ delivery: deliveryResult.delivery, state: turnState })
      .wait();
    state = turn.state;

    if (turn.kind === "waiting-approval" || turn.kind === "conversation-replied") continue;
    return await finishSession(backend, state, turn.terminal);
  }
}

async function nextDelivery(
  backend: LoopBackend,
  initialState: SessionState,
  initialDelivery: MessageDelivery | null,
): Promise<{ readonly delivery: Delivery; readonly state: SessionState }> {
  if (initialDelivery !== null) return { delivery: initialDelivery, state: initialState };

  let state = initialState;
  const pendingApproval = pendingApprovalRequestId(state.pending);
  const bufferedIndex = state.bufferedDeliveries.findIndex((delivery) =>
    pendingApproval === null
      ? delivery.kind === "message"
      : delivery.kind === "approval" && delivery.requestId === pendingApproval,
  );

  if (bufferedIndex !== -1) {
    const buffered = state.bufferedDeliveries[bufferedIndex];
    if (buffered === undefined) throw new Error("Buffered delivery disappeared.");
    state = {
      ...state,
      bufferedDeliveries: state.bufferedDeliveries.filter((_, index) => index !== bufferedIndex),
    };
    await backend.checkpoint(state);
    return { delivery: buffered, state };
  }

  while (true) {
    const delivery = await backend.receive();
    if (
      (pendingApproval === null && delivery.kind === "message") ||
      (pendingApproval !== null &&
        delivery.kind === "approval" &&
        delivery.requestId === pendingApproval)
    ) {
      return { delivery, state };
    }

    if (pendingApproval === null) continue;
    state = {
      ...state,
      bufferedDeliveries: [...state.bufferedDeliveries, delivery],
    };
    await backend.checkpoint(state);
  }
}

async function finishSession(
  backend: LoopBackend,
  state: SessionState,
  outcome: TerminalOutcome,
): Promise<TerminalOutcome> {
  await backend.checkpoint({ ...state, phase: "terminal" });
  await backend.finish(outcome);
  return outcome;
}

function pendingApprovalRequestId(exchange: OpenExchange | null): string | null {
  if (exchange === null) return null;
  return exchange.requests.find((request) => request.kind === "approval")?.requestId ?? null;
}
