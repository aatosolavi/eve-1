import { EffectExhaustedError } from "./effect-definitions.js";
import { childSessionId, operationId } from "./ids.js";
import { executeTool as invokeTool, generate as invokeGeneration } from "./program-effects.js";
import { writeEvent } from "./program-support.js";
import { closeExchange, openExchange, resolveExchangeRequest } from "./transcript.js";
import type {
  ApprovalDelivery,
  ApprovalRequest,
  ChildHandle,
  DelegatedSessionInput,
  GenerateInput,
  GeneratedTurn,
  OpenExchange,
  OperationId,
  RequestResult,
  SessionState,
  StepInput,
  StepResult,
  SubagentRequest,
  ToolRequest,
  TurnDependencies,
} from "./types.js";

export async function next(dependencies: TurnDependencies, input: StepInput): Promise<StepResult> {
  let state = input.state;
  if (state.pending !== null) {
    throw new Error("Pending exchange must be resolved before generation.");
  }

  const generation = await generateAtState(dependencies, state, {
    history: state.history,
    scenario: state.scenario,
    sessionId: state.sessionId,
    stepOrdinal: input.stepOrdinal,
    turnOrdinal: state.nextTurnOrdinal - 1,
  });
  const generated = generation.output;
  const operation = generation.operationId;
  let exchange = openGeneratedExchange(generated);
  await writeEvent(dependencies, operation, {
    requestCount: generated.requests.length,
    type: "model.generated",
  });

  if (generated.finish !== null) {
    state = closeStepExchange(state, exchange);
    await writeEvent(
      dependencies,
      operation,
      { output: generated.finish.output, type: "assistant.reply" },
      1,
    );
    if (state.mode === "conversation") {
      return { done: true, kind: "reply", output: generated.finish.output, state };
    }
    return {
      done: true,
      kind: "terminal",
      state,
      terminal: { kind: "completed", output: generated.finish.output },
    };
  }

  const approval = generated.requests.find(
    (request): request is ApprovalRequest => request.kind === "approval",
  );
  if (approval !== undefined) {
    state = { ...state, pending: exchange };
    await writeEvent(
      dependencies,
      operation,
      { requestId: approval.requestId, type: "approval.requested" },
      1,
    );
    return { done: true, kind: "waiting-approval", requestId: approval.requestId, state };
  }

  // Every subagent spawns before the first tool executes; children run while tools do.
  const children: { readonly child: ChildHandle; readonly request: SubagentRequest }[] = [];
  for (const request of generated.requests) {
    if (request.kind !== "subagent") continue;
    const child = dependencies.spawnChild(subagentInput(state, request));
    await writeEvent(
      dependencies,
      operationId(state.sessionId, state.nextTurnOrdinal - 1, `child-started:${request.requestId}`),
      { childId: child.id, requestId: request.requestId, type: "child.started" },
    );
    children.push({ child, request });
  }

  for (const request of generated.requests) {
    if (request.kind !== "tool") continue;
    const result = await executeTool(dependencies, state, request);
    exchange = resolveExchangeRequest(exchange, result);
  }

  // Child results fold back in request order, not completion order.
  for (const { child, request } of children) {
    const terminal = await child.wait();
    await writeEvent(
      dependencies,
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

  return { done: false, state: closeStepExchange(state, exchange) };
}

export async function resolveApproval(
  dependencies: TurnDependencies,
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

  const result: RequestResult = delivery.approved
    ? await executeTool(dependencies, state, request)
    : { isError: true, requestId: request.requestId, value: "denied" };
  const resolved = resolveExchangeRequest(exchange, result);
  return closeStepExchange(state, resolved);
}

function closeStepExchange(state: SessionState, exchange: OpenExchange): SessionState {
  const history = closeExchange(state.history, exchange);
  if (history === null) throw new Error("A step did not close its exchange.");
  return { ...state, history, pending: null };
}

function subagentInput(state: SessionState, request: SubagentRequest): DelegatedSessionInput {
  return {
    initialDelivery: {
      deliveryId: `${request.requestId}:delivery`,
      kind: "message",
      message: request.message,
    },
    mode: "task",
    requestId: request.requestId,
    scenario: { delayMs: request.delayMs, kind: "echo" },
    sessionId: childSessionId(state.sessionId, request.requestId),
  };
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

async function executeTool(
  dependencies: TurnDependencies,
  state: SessionState,
  request: ApprovalRequest | ToolRequest,
): Promise<RequestResult> {
  try {
    const executed = await invokeTool(dependencies, request);
    await writeEvent(dependencies, executed.operationId, {
      requestId: request.requestId,
      type: "tool.completed",
    });
    return executed.output;
  } catch (error) {
    if (!(error instanceof EffectExhaustedError)) throw error;
    throw new TurnEffectExhaustedError(state, error);
  }
}

async function generateAtState(
  dependencies: TurnDependencies,
  state: SessionState,
  input: GenerateInput,
): Promise<{
  readonly operationId: OperationId;
  readonly output: GeneratedTurn;
}> {
  try {
    return await invokeGeneration(dependencies, input);
  } catch (error) {
    if (!(error instanceof EffectExhaustedError)) throw error;
    throw new TurnEffectExhaustedError(state, error);
  }
}

export class TurnEffectExhaustedError extends Error {
  readonly effectError: EffectExhaustedError;
  readonly state: SessionState;

  constructor(state: SessionState, effectError: EffectExhaustedError) {
    super(effectError.message, { cause: effectError });
    this.effectError = effectError;
    this.name = "TurnEffectExhaustedError";
    this.state = state;
  }
}
