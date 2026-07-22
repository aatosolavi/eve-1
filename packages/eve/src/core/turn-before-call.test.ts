import { describe, expect, it } from "vitest";

import { assemblePrompt, resolveTurnInput } from "#core/index.js";
import type { BeforeCallPorts, ResolvedTurnInput, StepFlowTypes } from "#core/turn-before-call.js";

/** Minimal concrete binding: every payload is a tagged string or record. */
interface TestFlow extends StepFlowTypes {
  readonly emissionState: string;
  readonly history: string[];
  readonly limitGrant: string;
  readonly modelEnvironment: string;
  readonly outcome: { readonly parked: boolean; readonly tag: string };
  readonly prompt: { readonly history: string[]; readonly tag: string };
  readonly rejectedApprovals: string;
  readonly state: string;
  readonly stepInput: { readonly message?: string };
}

type PortOverrides = Partial<BeforeCallPorts<TestFlow>>;

function createPorts(overrides: PortOverrides = {}): {
  readonly calls: string[];
  readonly ports: BeforeCallPorts<TestFlow>;
} {
  const calls: string[] = [];
  const ports: BeforeCallPorts<TestFlow> = {
    emissionEnabled: true,
    readEmissionState: (state) => `emission(${state})`,
    consumeDeferredInput({ input, state }) {
      calls.push("consumeDeferredInput");
      return { input, state };
    },
    async resolveRuntimeActions({ state }) {
      calls.push("resolveRuntimeActions");
      return { history: ["h1"], outcome: "resolved", state };
    },
    convertStaleResponses({ input }) {
      calls.push("convertStaleResponses");
      return { displayInput: input, effectiveInput: input };
    },
    resolvePendingInput({ history, state }) {
      calls.push("resolvePendingInput");
      return {
        history,
        limitGrant: undefined,
        outcome: "resolved",
        rejectedApprovals: undefined,
        state,
      };
    },
    async emitRejectedApprovals(rejected) {
      calls.push(`emitRejectedApprovals(${String(rejected)})`);
    },
    async emitTurnPreamble({ emissionState }) {
      calls.push("emitTurnPreamble");
      return `${emissionState}+preamble`;
    },
    async emitTurnEpilogue({ emissionState }) {
      calls.push("emitTurnEpilogue");
      return `${emissionState}+epilogue`;
    },
    onTurnStarted(emissionState) {
      calls.push(`onTurnStarted(${emissionState})`);
    },
    async applyLimitContinuation({ state }) {
      calls.push("applyLimitContinuation");
      return { outcome: null, state };
    },
    classifyParked({ emissionState, state }) {
      calls.push("classifyParked");
      return { parked: true, tag: `${state}${emissionState === undefined ? "" : "+stamped"}` };
    },
    hasDeliveryInput: (input) => input !== undefined,
    appendDeliveryContext({ history }) {
      calls.push("appendDeliveryContext");
      return [...history, "context"];
    },
    async stageDeliveryMessage({ history, skipMessage }) {
      calls.push(`stageDeliveryMessage(skip=${String(skipMessage)})`);
      return skipMessage ? history : [...history, "message"];
    },
    async resolveActiveModel({ state }) {
      calls.push("resolveActiveModel");
      return { environment: "env", state: `${state}+model` };
    },
    async compactIfNeeded({ history, state }) {
      calls.push("compactIfNeeded");
      return { history, state };
    },
    async assembleModelPrompt({ history }) {
      calls.push("assembleModelPrompt");
      return { history, tag: "prompt" };
    },
    ...overrides,
  };
  return { calls, ports };
}

describe("resolveTurnInput", () => {
  it("parks without opening a turn when runtime actions are unresolved", async () => {
    const { calls, ports } = createPorts({
      async resolveRuntimeActions({ state }) {
        return { outcome: "unresolved", state };
      },
    });

    const resolution = await resolveTurnInput(ports, { input: { message: "hi" }, state: "s" });

    expect(resolution).toEqual({ kind: "settled", outcome: { parked: true, tag: "s" } });
    expect(calls).not.toContain("emitTurnPreamble");
  });

  it("opens and closes the turn before parking on a deferred delivery message", async () => {
    const { calls, ports } = createPorts({
      resolvePendingInput({ state }) {
        return { deferredMessage: true, outcome: "unresolved", state };
      },
    });

    const resolution = await resolveTurnInput(ports, { input: { message: "hi" }, state: "s" });

    // The parked outcome carries the emission coordinates of the turn it opened.
    expect(resolution).toEqual({ kind: "settled", outcome: { parked: true, tag: "s+stamped" } });
    expect(calls.filter((call) => call.startsWith("emit"))).toEqual([
      "emitTurnPreamble",
      "emitTurnEpilogue",
    ]);
  });

  it("parks silently on unresolved input without a fresh delivery", async () => {
    const { calls, ports } = createPorts({
      resolvePendingInput({ state }) {
        return { deferredMessage: true, outcome: "unresolved", state };
      },
    });

    const resolution = await resolveTurnInput(ports, { input: undefined, state: "s" });

    expect(resolution).toEqual({ kind: "settled", outcome: { parked: true, tag: "s" } });
    expect(calls).not.toContain("emitTurnPreamble");
  });

  it("settles with the limit-continuation outcome when the grant is denied", async () => {
    const { ports } = createPorts({
      async applyLimitContinuation({ state }) {
        return { outcome: { parked: false, tag: `limit(${state})` }, state };
      },
    });

    const resolution = await resolveTurnInput(ports, { input: { message: "hi" }, state: "s" });

    expect(resolution).toEqual({
      kind: "settled",
      outcome: { parked: false, tag: "limit(s)" },
    });
  });

  it("surfaces rejected approvals, opens the turn, and threads the resolved payload", async () => {
    const { calls, ports } = createPorts({
      resolvePendingInput({ history, state }) {
        return {
          consumedMessage: true,
          history: [...history, "folded"],
          limitGrant: "grant",
          outcome: "resolved",
          rejectedApprovals: "denied-batch",
          state: `${state}+pending`,
        };
      },
    });

    const resolution = await resolveTurnInput(ports, { input: { message: "hi" }, state: "s" });

    expect(resolution).toMatchObject({
      consumedMessage: true,
      history: ["h1", "folded"],
      kind: "resolved",
      state: "s+pending",
    });
    // Rejected approvals surface before the turn opens; the started hook
    // sees the post-preamble emission coordinates.
    expect(calls.filter((call) => call.startsWith("emit") || call.startsWith("onTurn"))).toEqual([
      "emitRejectedApprovals(denied-batch)",
      "emitTurnPreamble",
      "onTurnStarted(emission(s)+preamble)",
    ]);
  });

  it("never emits lifecycle events when emission is disabled", async () => {
    const { calls, ports } = createPorts({ emissionEnabled: false });

    const resolution = await resolveTurnInput(ports, { input: { message: "hi" }, state: "s" });

    expect(resolution.kind).toBe("resolved");
    expect(calls.some((call) => call.startsWith("emitTurn"))).toBe(false);
  });
});

describe("assemblePrompt", () => {
  function resolved(
    overrides: Partial<ResolvedTurnInput<TestFlow>> = {},
  ): ResolvedTurnInput<TestFlow> {
    return {
      effectiveInput: { message: "hi" },
      emissionState: "emission",
      history: ["h1"],
      state: "s",
      ...overrides,
    };
  }

  it("runs the context-engineering pipeline in order", async () => {
    const { calls, ports } = createPorts();

    const prompt = await assemblePrompt(ports, resolved());

    expect(prompt).toEqual({ history: ["h1", "context", "message"], tag: "prompt" });
    expect(calls).toEqual([
      "appendDeliveryContext",
      "stageDeliveryMessage(skip=false)",
      "resolveActiveModel",
      "compactIfNeeded",
      "assembleModelPrompt",
    ]);
  });

  it("skips the delivery message when it was deferred or already consumed", async () => {
    for (const flags of [{ consumedMessage: true }, { deferredMessage: true }]) {
      const { calls, ports } = createPorts();

      await assemblePrompt(ports, resolved(flags));

      expect(calls).toContain("stageDeliveryMessage(skip=true)");
    }
  });
});
