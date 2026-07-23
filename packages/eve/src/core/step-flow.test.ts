import { describe, expect, it } from "vitest";

import type {
  CallDependencies,
  CompactionDependencies,
  EventStream,
  FailureDependencies,
  ModelDependencies,
  PromptDependencies,
  SettleDependencies,
  StepFacets,
  StepFlowTypes,
  StepPorts,
  TraceDependencies,
  UsageDependencies,
  WaitDependencies,
} from "#core/step-ports.js";
import { assemblePrompt, generateStep, resolveTurnInput } from "#core/index.js";

/**
 * Minimal concrete binding: history entries are `"role:body"` strings,
 * every other payload is a tagged string or record.
 */
interface TestFlow extends StepFlowTypes {
  readonly ambientContext: string;
  readonly approvalResult: string;
  readonly callAttempt: string;
  readonly callResult: string;
  readonly callRunner: { readonly prompt: TestFlow["prompt"] };
  readonly cacheMarker: string;
  readonly cachePath: string;
  readonly compactionModel: string;
  readonly emissionState: string;
  readonly failureContent: string;
  readonly historyEntry: string;
  readonly limitGrant: string;
  readonly logFields: Record<string, unknown>;
  readonly model: string;
  readonly modelHeaders: string;
  readonly prompt: {
    readonly emptyDeliveryEnabled: boolean;
    readonly history: readonly string[];
    readonly modelEntries: readonly string[];
    readonly systemEntries: readonly string[];
  };
  readonly rejectedApprovals: readonly string[];
  readonly retryOptions: string;
  readonly state: string;
  readonly stepInput: { readonly message?: string };
  readonly turnTrace: string;
  readonly usage: unknown;
  readonly usageSnapshot: string;
  readonly userContent: string;
}

interface Overrides {
  readonly call?: Partial<CallDependencies<TestFlow>>;
  readonly compaction?: Partial<CompactionDependencies<TestFlow>>;
  /** `null` disables the event stream entirely. */
  readonly events?: Partial<EventStream<TestFlow>> | null;
  readonly facets?: Partial<StepFacets<TestFlow>>;
  readonly failure?: Partial<FailureDependencies<TestFlow>>;
  readonly mode?: "conversation" | "task";
  readonly model?: Partial<ModelDependencies<TestFlow>>;
  readonly prompt?: Partial<PromptDependencies<TestFlow>>;
  readonly settle?: Partial<SettleDependencies<TestFlow>>;
  readonly trace?: Partial<TraceDependencies<TestFlow>>;
  readonly usage?: Partial<UsageDependencies<TestFlow>>;
  readonly waits?: Partial<WaitDependencies<TestFlow>>;
}

function createPorts(over: Overrides = {}): {
  readonly calls: string[];
  readonly ports: StepPorts<TestFlow>;
} {
  const calls: string[] = [];
  const note = (name: string) => calls.push(name);

  const events: EventStream<TestFlow> = {
    compactionCompleted: async () => {
      note("events.compactionCompleted");
    },
    compactionRequested: async () => {
      note("events.compactionRequested");
    },
    failedStep: async ({ content }) => {
      note(`events.failedStep(${content})`);
    },
    recoverableFailedTurn: async ({ content, emissionState }) => {
      note(`events.recoverableFailedTurn(${content})`);
      return `${emissionState}+failed`;
    },
    rejectedApproval: async ({ result }) => {
      note(`events.rejectedApproval(${result})`);
    },
    stepStarted: async () => {
      note("events.stepStarted");
    },
    turnEpilogue: async ({ emissionState }) => {
      note("events.turnEpilogue");
      return `${emissionState}+epi`;
    },
    turnPreamble: async ({ emissionState }) => {
      note("events.turnPreamble");
      return `${emissionState}+pre`;
    },
    ...over.events,
  };

  const ports: StepPorts<TestFlow> = {
    mode: over.mode ?? "conversation",
    events: over.events === null ? undefined : events,
    identity: { environment: "test", eveVersion: "0.0.0", functionId: "fn" },
    log: {
      error: (message) => note(`log.error(${message})`),
      warn: (message) => note(`log.warn(${message})`),
    },
    facets: {
      approvalResultsOf: (batch) => batch,
      contextEntriesOf: () => undefined,
      deliveryContentOf: (input) => input?.message,
      hasDelivery: (input) => input !== undefined,
      hasOutputSchema: () => false,
      readEmission: (state) => `em(${state})`,
      sessionIdOf: () => "sid",
      turnIdOf: (emissionState) => `turn(${emissionState})`,
      writeEmission: (state, emissionState) => `${state}|${emissionState}`,
      ...over.facets,
    },
    waits: {
      applyLimitContinuation: async ({ state }) => ({ outcome: null, state }),
      consumeDeferredInput: ({ input, state }) => ({ input, state }),
      convertStaleResponses: ({ input }) => ({ displayInput: input, effectiveInput: input }),
      resolvePendingInput: ({ history, state }) => ({
        history,
        limitGrant: undefined,
        outcome: "resolved",
        rejectedApprovals: undefined,
        state,
      }),
      resolveRuntimeActions: async ({ state }) => ({
        history: ["user:h1"],
        outcome: "resolved",
        state,
      }),
      ...over.waits,
    },
    prompt: {
      conditionalDeliveryEntry: () => "system:conditional",
      dynamicInstructionEntries: () => [],
      finalize: ({ emptyDeliveryEnabled, history, modelEntries, systemEntries }) => ({
        emptyDeliveryEnabled,
        history,
        modelEntries,
        systemEntries,
      }),
      hydrate: async (history) => history,
      isSystemEntry: (entry) => entry.startsWith("system:"),
      skillAnnouncementEntry: () => undefined,
      stageAttachments: async (content) => `staged(${content})`,
      userEntry: (content) => `user:${content}`,
      ...over.prompt,
    },
    model: {
      ambient: () => undefined,
      anthropicCacheMarker: () => "anthropic-marker",
      attributionHeaders: () => "headers",
      cachePlan: (model) => ({ kind: "gateway", path: `cache(${model})` }),
      hasParentSession: () => false,
      isScheduleAuth: () => false,
      resolve: async ({ state }) => ({ model: "m", state }),
      ...over.model,
    },
    compaction: {
      postCompactionEntries: () => [],
      resolveModel: async () => "compaction-model",
      run: async ({ history }) => history,
      shouldCompact: () => false,
      ...over.compaction,
    },
    call: {
      assertNotCancelled: () => note("call.assertNotCancelled"),
      continueWorkflowInterrupt: async () => {
        note("call.continueWorkflowInterrupt");
        return null;
      },
      create: ({ prompt }) => {
        note("call.create");
        return { prompt };
      },
      currentState: () => "call-state",
      enforceTokenLimit: async () => {
        note("call.enforceTokenLimit");
        return null;
      },
      prepareAttempt: () => {
        note("call.prepareAttempt");
        return "attempt";
      },
      recoveryStages: [],
      run: async () => {
        note("call.run");
        return "result";
      },
      ...over.call,
    },
    failure: {
      classification: () => "terminal",
      describe: ({ error }) => ({
        content: "failure-content",
        logFields: {},
        taskOutput: `task(${(error as Error).message})`,
        upstreamMessage: undefined,
      }),
      describeStreamWrite: () => ({ content: "stream-write-content", logFields: {} }),
      isRetryBudgetConsumed: () => false,
      isStreamWriteFailure: () => false,
      ...over.failure,
    },
    usage: {
      accumulate: ({ result }) => ({ snapshot: `snap(${result})`, state: `accounted(${result})` }),
      publish: async ({ snapshot }) => {
        note(`usage.publish(${snapshot})`);
      },
      ...over.usage,
    },
    settle: {
      parked: ({ emissionState, state }) => ({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        state: emissionState === undefined ? state : `${state}+stamped(${emissionState})`,
      }),
      step: async ({ result, state }) => ({
        action: "done",
        output: `settled(${result})`,
        state,
      }),
      ...over.settle,
    },
    trace: {
      bind: ({ state }) => `${state}+traced`,
      end: (trace) => note(`trace.end(${trace})`),
      inContext: (_input, run) => run(),
      recordError: (trace) => note(`trace.recordError(${trace})`),
      setAttribute: (trace, key, value) => note(`trace.setAttribute(${trace},${key},${value})`),
      start: () => undefined,
      ...over.trace,
    },
  };
  return { calls, ports };
}

const delivery = { message: "hi" };

describe("resolveTurnInput", () => {
  const input = { input: delivery, state: "s", trace: undefined };

  it("parks without opening a turn when runtime actions are unresolved", async () => {
    const { calls, ports } = createPorts({
      waits: { resolveRuntimeActions: async ({ state }) => ({ outcome: "unresolved", state }) },
    });

    const resolution = await resolveTurnInput(ports, input);

    expect(resolution).toEqual({
      kind: "settled",
      outcome: {
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        state: "s",
      },
    });
    expect(calls).not.toContain("events.turnPreamble");
  });

  it("opens and closes the turn before parking on a deferred delivery message", async () => {
    const { calls, ports } = createPorts({
      waits: {
        resolvePendingInput: ({ state }) => ({
          deferredMessage: true,
          outcome: "unresolved",
          state,
        }),
      },
    });

    const resolution = await resolveTurnInput(ports, input);

    // The parked outcome carries the emission coordinates of the turn it
    // opened and closed.
    expect(resolution).toMatchObject({
      kind: "settled",
      outcome: { action: "park", state: "s+stamped(em(s)+pre+epi)" },
    });
    expect(calls).toEqual(["events.turnPreamble", "events.turnEpilogue"]);
  });

  it("parks silently on unresolved input without a fresh delivery", async () => {
    const { calls, ports } = createPorts({
      waits: {
        resolvePendingInput: ({ state }) => ({
          deferredMessage: true,
          outcome: "unresolved",
          state,
        }),
      },
    });

    const resolution = await resolveTurnInput(ports, {
      input: undefined,
      state: "s",
      trace: undefined,
    });

    expect(resolution).toMatchObject({ kind: "settled", outcome: { action: "park", state: "s" } });
    expect(calls).toEqual([]);
  });

  it("settles with the limit-continuation outcome when the grant is denied", async () => {
    const { ports } = createPorts({
      waits: {
        applyLimitContinuation: async ({ state }) => ({
          outcome: { action: "done", output: `limit(${state})`, state },
          state,
        }),
      },
    });

    const resolution = await resolveTurnInput(ports, input);

    expect(resolution).toMatchObject({
      kind: "settled",
      outcome: { action: "done", output: "limit(s)" },
    });
  });

  it("surfaces rejected approvals before opening the turn and tags the trace", async () => {
    const { calls, ports } = createPorts({
      waits: {
        resolvePendingInput: ({ history, state }) => ({
          consumedMessage: true,
          history: [...history, "user:folded"],
          limitGrant: "grant",
          outcome: "resolved",
          rejectedApprovals: ["r1", "r2"],
          state: `${state}+pending`,
        }),
      },
    });

    const resolution = await resolveTurnInput(ports, { input: delivery, state: "s", trace: "T" });

    expect(resolution).toMatchObject({
      consumedMessage: true,
      history: ["user:h1", "user:folded"],
      kind: "resolved",
      state: "s+pending",
    });
    expect(calls).toEqual([
      "events.rejectedApproval(r1)",
      "events.rejectedApproval(r2)",
      "events.turnPreamble",
      "trace.setAttribute(T,eve.turn.id,turn(em(s)+pre))",
    ]);
  });

  it("never emits lifecycle events when the step has no event stream", async () => {
    const { calls, ports } = createPorts({ events: null });

    const resolution = await resolveTurnInput(ports, input);

    expect(resolution.kind).toBe("resolved");
    expect(calls).toEqual([]);
  });
});

describe("assemblePrompt", () => {
  function resolved(overrides: Partial<Parameters<typeof assemblePrompt<TestFlow>>[1]> = {}) {
    return {
      effectiveInput: delivery,
      emissionState: "em",
      history: ["user:h1"],
      state: "s",
      ...overrides,
    };
  }

  it("appends context entries and the staged delivery message in order", async () => {
    const { ports } = createPorts({ facets: { contextEntriesOf: () => ["c1", "c2"] } });

    const prompt = await assemblePrompt(ports, resolved());

    expect(prompt.history).toEqual(["user:h1", "user:c1", "user:c2", "user:staged(hi)"]);
  });

  it("skips the delivery message when it was deferred or already consumed", async () => {
    for (const flags of [{ consumedMessage: true }, { deferredMessage: true }]) {
      const { ports } = createPorts();

      const prompt = await assemblePrompt(ports, resolved(flags));

      expect(prompt.history).toEqual(["user:h1"]);
    }
  });

  it("runs the compaction choreography when over the threshold", async () => {
    const { calls, ports } = createPorts({
      compaction: {
        postCompactionEntries: () => ["user:reinjected"],
        run: async () => ["user:summary"],
        shouldCompact: () => true,
      },
    });

    const prompt = await assemblePrompt(ports, resolved());

    expect(prompt.history).toEqual(["user:summary", "user:reinjected"]);
    expect(calls).toEqual(["events.compactionRequested", "events.compactionCompleted"]);
  });

  it("routes system entries and the conditional-delivery instruction to the system channel", async () => {
    const { ports } = createPorts({
      model: { ambient: () => "ctx", isScheduleAuth: () => true },
      prompt: {
        dynamicInstructionEntries: () => ["system:dynamic"],
        skillAnnouncementEntry: () => "system:skill",
      },
      waits: {
        resolveRuntimeActions: async ({ state }) => ({
          history: ["system:base", "user:h1"],
          outcome: "resolved",
          state,
        }),
      },
    });

    const prompt = await assemblePrompt(ports, resolved({ history: ["system:base", "user:h1"] }));

    expect(prompt.emptyDeliveryEnabled).toBe(true);
    expect(prompt.modelEntries).toEqual(["user:h1", "user:staged(hi)"]);
    expect(prompt.systemEntries).toEqual([
      "system:base",
      "system:dynamic",
      "system:skill",
      "system:conditional",
    ]);
  });
});

describe("generateStep", () => {
  const input = { input: delivery, state: "s" };

  it("runs the phases in order and settles the successful call", async () => {
    const { calls, ports } = createPorts();

    const outcome = await generateStep(ports, input);

    expect(outcome).toEqual({
      action: "done",
      output: "settled(result)",
      state: "accounted(result)",
    });
    expect(calls).toEqual([
      "events.turnPreamble",
      "call.create",
      "call.prepareAttempt",
      "events.stepStarted",
      "call.continueWorkflowInterrupt",
      "call.enforceTokenLimit",
      "call.run",
      "usage.publish(snap(result))",
    ]);
  });

  it("settles on a pending workflow interrupt without a model call", async () => {
    const { calls, ports } = createPorts({
      call: {
        continueWorkflowInterrupt: async () => ({ action: "continue", state: "interrupted" }),
      },
    });

    await expect(generateStep(ports, input)).resolves.toEqual({
      action: "continue",
      state: "interrupted",
    });
    expect(calls).not.toContain("call.run");
  });

  it("settles on the token limit without a model call", async () => {
    const { calls, ports } = createPorts({
      call: { enforceTokenLimit: async () => ({ action: "done", output: "limit", state: "s" }) },
    });

    await expect(generateStep(ports, input)).resolves.toMatchObject({ output: "limit" });
    expect(calls).not.toContain("call.run");
  });

  it("threads error and retry options through the recovery stages in order", async () => {
    const seen: string[] = [];
    const { ports } = createPorts({
      call: {
        recoveryStages: [
          async ({ error }) => {
            seen.push(`stage1(${(error as Error).message})`);
            return { error: new Error("rewritten"), outcome: "failed", retryOptions: "opts" };
          },
          async ({ error, retryOptions }) => {
            seen.push(`stage2(${(error as Error).message},${String(retryOptions)})`);
            return { outcome: "recovered", result: "reissued" };
          },
        ],
        run: () => Promise.reject(new Error("boom")),
      },
    });

    await expect(generateStep(ports, input)).resolves.toMatchObject({
      output: "settled(reissued)",
    });
    expect(seen).toEqual(["stage1(boom)", "stage2(rewritten,opts)"]);
  });

  it("records the failure on the trace and rethrows raw without an event stream", async () => {
    const boom = new Error("boom");
    const { calls, ports } = createPorts({
      call: { run: () => Promise.reject(boom) },
      events: null,
      trace: { start: () => "T" },
    });

    await expect(generateStep(ports, input)).rejects.toBe(boom);
    expect(calls).toContain("trace.recordError(T)");
  });

  it("parks a stream-write failure even in task mode", async () => {
    const { calls, ports } = createPorts({
      call: { run: () => Promise.reject(new Error("boom")) },
      failure: { isStreamWriteFailure: () => true },
      mode: "task",
    });

    const outcome = await generateStep(ports, input);

    expect(outcome).toMatchObject({
      action: "park",
      state: "call-state+stamped(em(s)+pre+failed)",
    });
    expect(calls).toContain("events.recoverableFailedTurn(stream-write-content)");
    expect(calls).toContain(
      "log.error(workflow stream write failed — parking session for retry by the user)",
    );
  });

  it("completes a terminal failure as the task's error result in task mode", async () => {
    const { calls, ports } = createPorts({
      call: { run: () => Promise.reject(new Error("boom")) },
      mode: "task",
    });

    await expect(generateStep(ports, input)).resolves.toEqual({
      action: "done",
      isError: true,
      output: "task(boom)",
      state: "call-state",
    });
    expect(calls).toContain("events.failedStep(failure-content)");
  });

  it("completes a terminal failure with empty output in conversation mode", async () => {
    const { ports } = createPorts({ call: { run: () => Promise.reject(new Error("boom")) } });

    await expect(generateStep(ports, input)).resolves.toEqual({
      action: "done",
      output: "",
      state: "call-state",
    });
  });

  it("prefers the recognized-terminal log line when one exists", async () => {
    const { calls, ports } = createPorts({
      call: { run: () => Promise.reject(new Error("boom")) },
      failure: {
        describe: () => ({
          content: "failure-content",
          logFields: {},
          recognizedTerminal: { fields: {}, message: "KnownError: fix your config" },
          taskOutput: "out",
          upstreamMessage: "upstream says no",
        }),
      },
    });

    await generateStep(ports, input);

    expect(calls).toContain("log.error(KnownError: fix your config)");
  });

  it("rethrows a task-retriable failure for the durable step retry", async () => {
    const boom = new Error("boom");
    const { calls, ports } = createPorts({
      call: { run: () => Promise.reject(boom) },
      failure: { classification: () => "recoverable" },
      mode: "task",
    });

    await expect(generateStep(ports, input)).rejects.toBe(boom);
    expect(calls.some((call) => call.startsWith("log.warn(model call failed recoverably"))).toBe(
      true,
    );
  });

  it("fails the task when a recoverable error exhausted its retry budget", async () => {
    const { ports } = createPorts({
      call: { run: () => Promise.reject(new Error("boom")) },
      failure: { classification: () => "recoverable", isRetryBudgetConsumed: () => true },
      mode: "task",
    });

    await expect(generateStep(ports, input)).resolves.toMatchObject({
      action: "done",
      isError: true,
    });
  });

  it("parks a conversation on any non-terminal failure", async () => {
    const { ports } = createPorts({
      call: { run: () => Promise.reject(new Error("boom")) },
      failure: { classification: () => "retry" },
    });

    await expect(generateStep(ports, input)).resolves.toMatchObject({ action: "park" });
  });

  it("opens the turn trace on a delivery step, runs inside it, and ends it", async () => {
    const events: string[] = [];
    const { ports } = createPorts({
      trace: {
        start: (name, attributes) => {
          events.push(
            `start(${name},${attributes["eve.session.id"]},${attributes["ai.telemetry.functionId"]})`,
          );
          return "T";
        },
        inContext: ({ state, trace }, run) => {
          events.push(`context(${state},${String(trace)})`);
          return run();
        },
        end: (trace) => {
          events.push(`end(${trace})`);
        },
      },
    });

    await generateStep(ports, input);

    // The flow observes the trace-bound state; the trace closes after it.
    expect(events).toEqual(["start(ai.eve.turn,sid,fn)", "context(s+traced,T)", "end(T)"]);
  });

  it("does not open a trace for a continuation step", async () => {
    const { ports } = createPorts({
      trace: {
        start: () => {
          throw new Error("continuation steps never open a turn trace");
        },
      },
    });

    await expect(generateStep(ports, { input: undefined, state: "s" })).resolves.toMatchObject({
      action: "done",
    });
  });
});
