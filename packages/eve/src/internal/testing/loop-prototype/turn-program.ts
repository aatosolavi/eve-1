import { EffectExhaustedError } from "./effect-definitions.js";
import { childSessionId, operationId } from "./ids.js";
import { executeTool as invokeTool, generate as invokeGeneration } from "./program-effects.js";
import { appendEvent } from "./program-support.js";
import { appendUser, closeExchange, openExchange, resolveExchangeRequest } from "./transcript.js";
import type {
  ApprovalDelivery,
  ApprovalRequest,
  ChildHandle,
  GenerateInput,
  GeneratedTurn,
  LoopBackend,
  LoopRequest,
  OpenExchange,
  OperationId,
  RequestResult,
  SessionState,
  SubagentRequest,
  TerminalOutcome,
  TurnOutcome,
  TurnProgramInput,
  WireValue,
} from "./types.js";

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

    const result = await executeModelLoop(backend, state);
    state = {
      ...result.state,
      phase: result.kind === "terminal" ? "terminal" : "between-turns",
    };
    await backend.checkpoint(state);

    if (result.kind === "waiting-approval") {
      return { kind: "waiting-approval", requestId: result.requestId, state };
    }
    if (result.kind === "terminal") {
      return { kind: "task-terminal", state, terminal: result.terminal };
    }
    return { kind: "conversation-replied", output: result.output, state };
  } catch (error) {
    if (!(error instanceof TurnEffectExhaustedError)) throw error;
    const terminal: Extract<TerminalOutcome, { readonly kind: "failed" }> = {
      error: error.effectError.failure,
      kind: "failed",
    };
    const failedState = { ...error.state, phase: "terminal" } as const;
    await appendEvent(
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

type ModelLoopResult =
  | { readonly kind: "reply"; readonly output: WireValue; readonly state: SessionState }
  | { readonly kind: "waiting-approval"; readonly requestId: string; readonly state: SessionState }
  | { readonly kind: "terminal"; readonly state: SessionState; readonly terminal: TerminalOutcome };

async function executeModelLoop(
  backend: LoopBackend,
  initialState: SessionState,
): Promise<ModelLoopResult> {
  let state = initialState;
  let generationOrdinal = 0;

  while (true) {
    if (state.pending !== null) {
      throw new Error("Pending exchange must be resolved before generation.");
    }

    const generateInput: GenerateInput = {
      generationOrdinal: generationOrdinal++,
      history: state.history,
      scenario: state.scenario,
      sessionId: state.sessionId,
      turnOrdinal: state.nextTurnOrdinal - 1,
    };
    const generation = await generateAtState(backend, state, generateInput);
    const generated = generation.output;
    const generationOperation = generation.operationId;
    let exchange = openGeneratedExchange(generated);
    await appendEvent(backend, generationOperation, {
      requestCount: generated.requests.length,
      type: "model.generated",
    });

    const approval = generated.requests.find(
      (request): request is ApprovalRequest => request.kind === "approval",
    );
    if (approval !== undefined) {
      state = { ...state, pending: exchange };
      await appendEvent(
        backend,
        generationOperation,
        { requestId: approval.requestId, type: "approval.requested" },
        1,
      );
      return { kind: "waiting-approval", requestId: approval.requestId, state };
    }

    const immediate = await resolveImmediateRequests(backend, state, exchange);
    exchange = immediate.exchange;
    state = immediate.state;
    const history = closeExchange(state.history, exchange);
    if (history === null) throw new Error("Immediate requests did not close their exchange.");
    state = { ...state, history, pending: null };

    if (generated.finish === null) continue;

    await appendEvent(
      backend,
      generationOperation,
      { output: generated.finish.output, type: "assistant.reply" },
      1,
    );

    if (state.mode === "conversation") {
      return { kind: "reply", output: generated.finish.output, state };
    }
    return {
      kind: "terminal",
      state,
      terminal: { kind: "completed", output: generated.finish.output },
    };
  }
}

function openGeneratedExchange(generated: GeneratedTurn): OpenExchange {
  if (generated.finish === null && generated.requests.length === 0) {
    throw new Error("Generation returned neither a terminal output nor a request.");
  }
  if (generated.finish !== null && generated.requests.length > 0) {
    throw new Error("Generation returned terminal output together with unresolved requests.");
  }
  const approvalCount = generated.requests.filter((request) => request.kind === "approval").length;
  if (approvalCount > 0 && (approvalCount !== 1 || generated.requests.length !== 1)) {
    throw new Error("Generation mixed an approval with another unresolved request.");
  }
  return openExchange({ assistant: generated.assistant, requests: generated.requests });
}

async function resolveImmediateRequests(
  backend: LoopBackend,
  initialState: SessionState,
  initialExchange: OpenExchange,
): Promise<{ readonly exchange: OpenExchange; readonly state: SessionState }> {
  let state = initialState;
  let exchange = initialExchange;
  const subagents: { readonly child: ChildHandle; readonly request: SubagentRequest }[] = [];

  for (const request of exchange.requests) {
    if (request.kind === "approval") continue;

    if (request.kind === "tool") {
      const executed = await executeTool(backend, state, request);
      state = executed.state;
      exchange = resolveExchangeRequest(exchange, executed.result);
      continue;
    }

    const childSession = childSessionId(state.sessionId, request.requestId);
    const child = backend.spawnChild({
      initialDelivery: {
        deliveryId: `${request.requestId}:delivery`,
        kind: "message",
        message: request.message,
      },
      mode: "task",
      requestId: request.requestId,
      scenario: { delayMs: request.delayMs, kind: "echo" },
      sessionId: childSession,
    });
    await appendEvent(
      backend,
      operationId(state.sessionId, state.nextTurnOrdinal - 1, `child-started:${request.requestId}`),
      { childId: child.id, requestId: request.requestId, type: "child.started" },
    );
    subagents.push({ child, request });
  }

  for (const { child, request } of subagents) {
    const terminal = await child.wait();
    await appendEvent(
      backend,
      operationId(state.sessionId, state.nextTurnOrdinal - 1, `child-result:${request.requestId}`),
      {
        childId: child.id,
        outcome: terminal.kind,
        requestId: request.requestId,
        type: "child.result",
      },
    );
    exchange = resolveExchangeRequest(exchange, {
      isError: terminal.kind === "failed",
      requestId: request.requestId,
      value: terminal.kind === "completed" ? terminal.output : terminal.error.message,
    });
  }

  return { exchange, state };
}

async function executeTool(
  backend: LoopBackend,
  state: SessionState,
  request: ApprovalRequest | Extract<LoopRequest, { readonly kind: "tool" }>,
): Promise<{ readonly result: RequestResult; readonly state: SessionState }> {
  let result: RequestResult;
  try {
    const executed = await invokeTool(backend, request);
    result = executed.output;
    await appendEvent(backend, executed.operationId, {
      requestId: request.requestId,
      type: "tool.completed",
    });
  } catch (error) {
    if (!(error instanceof EffectExhaustedError)) throw error;
    throw new TurnEffectExhaustedError(state, error);
  }
  return { result, state };
}

async function resolveApproval(
  backend: LoopBackend,
  state: SessionState,
  delivery: ApprovalDelivery,
): Promise<SessionState> {
  const exchange = state.pending;
  if (exchange === null) throw new Error("Approval delivery has no pending exchange.");

  const request = exchange.requests.find(
    (candidate): candidate is ApprovalRequest =>
      candidate.kind === "approval" && candidate.requestId === delivery.requestId,
  );
  if (request === undefined) {
    throw new Error(`Approval delivery does not match request "${delivery.requestId}".`);
  }

  const executed = delivery.approved
    ? await executeTool(backend, state, request)
    : {
        result: { isError: true, requestId: request.requestId, value: "denied" as const },
        state,
      };
  const resolved = resolveExchangeRequest(exchange, executed.result);
  const history = closeExchange(executed.state.history, resolved);
  if (history === null) throw new Error("Approval did not close its exchange.");

  return { ...executed.state, history, pending: null };
}

async function generateAtState(
  backend: LoopBackend,
  state: SessionState,
  input: GenerateInput,
): Promise<{
  readonly operationId: OperationId;
  readonly output: GeneratedTurn;
}> {
  try {
    return await invokeGeneration(backend, input);
  } catch (error) {
    if (!(error instanceof EffectExhaustedError)) throw error;
    throw new TurnEffectExhaustedError(state, error);
  }
}

class TurnEffectExhaustedError extends Error {
  readonly effectError: EffectExhaustedError;
  readonly state: SessionState;

  constructor(state: SessionState, effectError: EffectExhaustedError) {
    super(effectError.message, { cause: effectError });
    this.effectError = effectError;
    this.name = "TurnEffectExhaustedError";
    this.state = state;
  }
}
