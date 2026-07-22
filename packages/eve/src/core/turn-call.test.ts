import { describe, expect, it } from "vitest";

import { generateStep } from "#core/index.js";
import type { StepFlowTypes } from "#core/turn-before-call.js";
import type { CallFailure, StepPorts } from "#core/turn-call.js";

/** Minimal concrete binding: every payload is a tagged string or record. */
interface TestFlow extends StepFlowTypes {
  readonly callResult: string;
  readonly callRunner: { readonly prompt: { readonly tag: string } };
  readonly emissionState: string;
  readonly history: string[];
  readonly limitGrant: string;
  readonly modelEnvironment: string;
  readonly outcome: { readonly via: string };
  readonly prompt: { readonly tag: string };
  readonly rejectedApprovals: string;
  readonly state: string;
  readonly stepInput: { readonly message?: string };
}

interface Scenario {
  readonly failure?: CallFailure;
  readonly mode?: "conversation" | "task";
  readonly emissionEnabled?: boolean;
  readonly run?: () => Promise<string>;
  readonly recover?: () => Promise<
    { outcome: "recovered"; result: string } | { outcome: "failed"; error: unknown }
  >;
  readonly interrupt?: { readonly via: string } | null;
  readonly limit?: { readonly via: string } | null;
}

function createPorts(scenario: Scenario = {}): {
  readonly calls: string[];
  readonly ports: StepPorts<TestFlow>;
} {
  const calls: string[] = [];
  const track =
    <T>(name: string, value: T) =>
    (): Promise<T> => {
      calls.push(name);
      return Promise.resolve(value);
    };
  const ports: StepPorts<TestFlow> = {
    // Pre-call ports: minimal straight-through fakes.
    emissionEnabled: scenario.emissionEnabled ?? true,
    readEmissionState: (state) => `emission(${state})`,
    consumeDeferredInput: ({ input, state }) => ({ input, state }),
    resolveRuntimeActions: async ({ state }) => ({
      history: ["h1"],
      outcome: "resolved",
      state,
    }),
    convertStaleResponses: ({ input }) => ({ displayInput: input, effectiveInput: input }),
    resolvePendingInput: ({ history, state }) => ({
      history,
      limitGrant: undefined,
      outcome: "resolved",
      rejectedApprovals: undefined,
      state,
    }),
    emitRejectedApprovals: async () => {},
    emitTurnPreamble: async ({ emissionState }) => emissionState,
    emitTurnEpilogue: async ({ emissionState }) => emissionState,
    applyLimitContinuation: async ({ state }) => ({ outcome: null, state }),
    classifyParked: ({ state }) => ({ via: `parked(${state})` }),
    hasDeliveryInput: (input) => input !== undefined,
    appendDeliveryContext: ({ history }) => history,
    stageDeliveryMessage: async ({ history }) => history,
    resolveActiveModel: async ({ state }) => ({ environment: "env", state }),
    compactIfNeeded: async ({ history, state }) => ({ history, state }),
    assembleModelPrompt: async () => ({ tag: "prompt" }),

    // Call ports: instrumented for order and decision assertions.
    mode: scenario.mode ?? "conversation",
    prepareModelCall({ prompt }) {
      calls.push("prepareModelCall");
      return { prompt };
    },
    emitStepStarted: async (runner) => {
      calls.push(`emitStepStarted(${runner.prompt.tag})`);
    },
    continueWorkflowInterrupt: track("continueWorkflowInterrupt", scenario.interrupt ?? null),
    enforceTokenLimit: track("enforceTokenLimit", scenario.limit ?? null),
    async runModelCall() {
      calls.push("runModelCall");
      return scenario.run === undefined ? "result" : await scenario.run();
    },
    assertNotCancelled: () => {
      calls.push("assertNotCancelled");
    },
    async recoverModelCall({ error }) {
      calls.push("recoverModelCall");
      return scenario.recover === undefined
        ? { error, outcome: "failed" }
        : await scenario.recover();
    },
    recordCallFailure: () => {
      calls.push("recordCallFailure");
    },
    classifyCallFailure: () => scenario.failure ?? { kind: "terminal" },
    parkAfterCallFailure: async ({ failure }) => ({ via: `park(${failure.kind})` }),
    failStep: async ({ asTaskError, failure }) => ({
      via: `fail(${failure.kind},taskError=${String(asTaskError)})`,
    }),
    onTaskRetryRethrow: () => {
      calls.push("onTaskRetryRethrow");
    },
    accountUsage: async ({ result }) => `accounted(${result})`,
    settleStep: async ({ result, state }) => ({ via: `settled(${result},${state})` }),
  };
  return { calls, ports };
}

const input = { input: { message: "hi" }, state: "s" };

describe("generateStep", () => {
  it("runs the phases in order and settles the successful call", async () => {
    const { calls, ports } = createPorts();

    const outcome = await generateStep(ports, input);

    expect(outcome).toEqual({ via: "settled(result,accounted(result))" });
    expect(calls).toEqual([
      "prepareModelCall",
      "emitStepStarted(prompt)",
      "continueWorkflowInterrupt",
      "enforceTokenLimit",
      "runModelCall",
    ]);
  });

  it("settles on a pending workflow interrupt without a model call", async () => {
    const { calls, ports } = createPorts({ interrupt: { via: "interrupt" } });

    await expect(generateStep(ports, input)).resolves.toEqual({ via: "interrupt" });
    expect(calls).not.toContain("runModelCall");
  });

  it("settles on the token limit without a model call", async () => {
    const { calls, ports } = createPorts({ limit: { via: "limit" } });

    await expect(generateStep(ports, input)).resolves.toEqual({ via: "limit" });
    expect(calls).not.toContain("runModelCall");
  });

  it("uses the recovered result when the recovery pipeline succeeds", async () => {
    const { ports } = createPorts({
      recover: async () => ({ outcome: "recovered", result: "reissued" }),
      run: () => Promise.reject(new Error("boom")),
    });

    await expect(generateStep(ports, input)).resolves.toEqual({
      via: "settled(reissued,accounted(reissued))",
    });
  });

  it("rethrows an unrecovered failure raw when emission is disabled", async () => {
    const boom = new Error("boom");
    const { calls, ports } = createPorts({
      emissionEnabled: false,
      run: () => Promise.reject(boom),
    });

    await expect(generateStep(ports, { input: undefined, state: "s" })).rejects.toBe(boom);
    expect(calls).toContain("recordCallFailure");
  });

  it("parks a stream-write failure even in task mode", async () => {
    const { ports } = createPorts({
      failure: { kind: "stream-write" },
      mode: "task",
      run: () => Promise.reject(new Error("boom")),
    });

    await expect(generateStep(ports, input)).resolves.toEqual({ via: "park(stream-write)" });
  });

  it.each([
    { asTaskError: "true", mode: "task" as const },
    { asTaskError: "false", mode: "conversation" as const },
  ])(
    "fails a terminal error as taskError=$asTaskError in $mode mode",
    async ({ asTaskError, mode }) => {
      const { ports } = createPorts({ mode, run: () => Promise.reject(new Error("boom")) });

      await expect(generateStep(ports, input)).resolves.toEqual({
        via: `fail(terminal,taskError=${asTaskError})`,
      });
    },
  );

  it("rethrows a task-retriable failure for the durable step retry", async () => {
    const boom = new Error("boom");
    const { calls, ports } = createPorts({
      failure: { kind: "recoverable", retriableInTask: true },
      mode: "task",
      run: () => Promise.reject(boom),
    });

    await expect(generateStep(ports, input)).rejects.toBe(boom);
    expect(calls).toContain("onTaskRetryRethrow");
  });

  it("fails the task when a recoverable error exhausted its retry budget", async () => {
    const { ports } = createPorts({
      failure: { kind: "recoverable", retriableInTask: false },
      mode: "task",
      run: () => Promise.reject(new Error("boom")),
    });

    await expect(generateStep(ports, input)).resolves.toEqual({
      via: "fail(recoverable,taskError=true)",
    });
  });

  it("parks a conversation on any non-terminal failure", async () => {
    const { ports } = createPorts({
      failure: { kind: "recoverable", retriableInTask: true },
      run: () => Promise.reject(new Error("boom")),
    });

    await expect(generateStep(ports, input)).resolves.toEqual({ via: "park(recoverable)" });
  });
});
