import { describe, expect, it } from "vitest";

import { EffectExhaustedError, EffectProtocolError } from "./effect-definitions.js";
import { executionId, sessionId } from "./ids.js";
import { runSession, runTurn } from "./programs.js";
import { emptyHistory } from "./transcript.js";
import type {
  ApprovalRequest,
  ChildHandle,
  DelegatedSessionInput,
  Delivery,
  GenerateInput,
  GeneratedTurn,
  LoopBackend,
  RequestResult,
  SessionProgramInput,
  SessionState,
  Stream,
  StreamEvent,
  TerminalOutcome,
  ToolRequest,
  TurnHandle,
  TurnProgramInput,
} from "./types.js";

describe("loop programs", () => {
  it("does not translate checkpoint failures into effect failures", async () => {
    const backend = new ProgramBackend("checkpoint");

    await expect(runTurn(backend, turnInput())).rejects.toThrow(
      "checkpoint acknowledgement failed",
    );
  });

  it("does not translate effect protocol failures into domain failures", async () => {
    const backend = new ProgramBackend("effect-protocol");

    await expect(runTurn(backend, turnInput())).rejects.toThrow(EffectProtocolError);
  });

  it("preserves the backend failure code in a typed turn outcome", async () => {
    const backend = new ProgramBackend("effect-exhausted");

    await expect(runTurn(backend, turnInput())).resolves.toMatchObject({
      kind: "task-terminal",
      terminal: {
        error: { code: "PROVIDER_UNAVAILABLE", message: "provider unavailable" },
        kind: "failed",
      },
    });
  });

  it("leaves terminal publication to finish", async () => {
    const backend = new ProgramBackend("finish");

    await expect(runSession(backend, sessionInput())).rejects.toThrow("finalization unavailable");
    expect(backend.events).toEqual([]);
  });
});

class ProgramBackend implements LoopBackend {
  readonly executionId = executionId("program:execution");
  readonly events: StreamEvent[] = [];
  readonly stream: Stream = {
    append: (event) => {
      this.events.push(event);
      return Promise.resolve();
    },
  };
  readonly #failure: "checkpoint" | "effect-exhausted" | "effect-protocol" | "finish";
  #checkpointFailed = false;

  constructor(failure: "checkpoint" | "effect-exhausted" | "effect-protocol" | "finish") {
    this.#failure = failure;
  }

  async checkpoint(): Promise<void> {
    if (this.#failure !== "checkpoint" || this.#checkpointFailed) return;
    this.#checkpointFailed = true;
    throw new Error("checkpoint acknowledgement failed");
  }

  async executeTool(_request: ApprovalRequest | ToolRequest): Promise<RequestResult> {
    throw new Error("Test did not expect a tool request.");
  }

  async finish(_outcome: TerminalOutcome): Promise<void> {
    if (this.#failure === "finish") throw new Error("finalization unavailable");
  }

  async generate(_input: GenerateInput): Promise<GeneratedTurn> {
    if (this.#failure === "effect-protocol") {
      throw new EffectProtocolError("conflicting operation identity");
    }
    if (this.#failure === "effect-exhausted") {
      throw new EffectExhaustedError("generate", {
        code: "PROVIDER_UNAVAILABLE",
        message: "provider unavailable",
      });
    }
    return {
      assistant: { content: "done", requestIds: [], role: "assistant" },
      finish: { output: "done" },
      requests: [],
    };
  }

  async receive(): Promise<Delivery> {
    throw new Error("Test did not expect public input.");
  }

  spawnChild(_input: DelegatedSessionInput): ChildHandle {
    throw new Error("Test did not expect a session child.");
  }

  spawnTurn(input: TurnProgramInput): TurnHandle {
    return {
      id: "program:turn" as TurnHandle["id"],
      wait: () =>
        Promise.resolve({
          kind: "task-terminal",
          state: { ...input.state, phase: "terminal" },
          terminal: { kind: "completed", output: "done" },
        }),
    };
  }
}

function sessionInput(): SessionProgramInput {
  return {
    initialDelivery: {
      deliveryId: "program:initial",
      kind: "message",
      message: "hello",
    },
    mode: "task",
    scenario: { kind: "echo" },
    sessionId: sessionId("program"),
  };
}

function turnInput(): TurnProgramInput {
  return {
    delivery: {
      deliveryId: "program:initial",
      kind: "message",
      message: "hello",
    },
    state: state(),
  };
}

function state(): SessionState {
  return {
    bufferedDeliveries: [],
    history: emptyHistory(),
    mode: "task",
    nextTurnOrdinal: 1,
    pending: null,
    phase: "turn",
    scenario: { kind: "echo" },
    sessionId: sessionId("program"),
  };
}
