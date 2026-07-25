import { trace } from "#compiled/@opentelemetry/api/index.js";
import type { LanguageModel, ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { setPendingRuntimeActionBatch } from "#core/runtime-actions.js";
import { CONDITIONAL_DELIVERY_INSTRUCTION } from "#core/shared/empty-delivery.js";
import { setPendingInputBatch } from "#core/input-requests.js";
import { createSessionLimitContinuationRequest } from "#core/session-limit-continuation.js";
import { EmptyModelResponseError } from "#core/model-call-error.js";
import type { RecoveryStage, StepServices } from "#core/step-services.js";
import { setTurnUsageState } from "#core/turn-tag-state.js";
import { assemblePrompt, generateStep, resolveTurnInput } from "#core/index.js";
import type { HarnessStepResult } from "#core/step-hooks.js";
import type { ModelCallRunner } from "#harness/model-call.js";
import type { GenerateConfig, HarnessSession, StepInput } from "#core/step-types.js";

interface Overrides {
  readonly ambient?: Partial<StepServices["ambient"]>;
  readonly attachments?: Partial<StepServices["attachments"]>;
  readonly config?: Partial<GenerateConfig>;
  readonly events?: boolean;
  readonly failure?: Partial<StepServices["failure"]>;
  readonly modelCall?: Partial<StepServices["modelCall"]>;
  readonly trace?: Partial<StepServices["trace"]>;
  readonly usage?: Partial<StepServices["usage"]>;
}

function createSession(overrides: Partial<HarnessSession> = {}): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "system",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "continuation",
    history: [],
    sessionId: "session",
    ...overrides,
  };
}

function successfulResult(text = "result"): HarnessStepResult {
  return {
    content: [],
    finishReason: "stop",
    providerMetadata: undefined,
    response: {
      id: "response",
      messages: [],
      modelId: "test-model",
      timestamp: new Date(0),
    },
    text,
    toolCalls: [],
    toolResults: [],
    usage: {
      inputTokenDetails: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        noCacheTokens: 2,
      },
      inputTokens: 2,
      outputTokenDetails: { reasoningTokens: 0, textTokens: 1 },
      outputTokens: 1,
      totalTokens: 3,
    },
  };
}

function createRunner(session: HarnessSession, result: HarnessStepResult): ModelCallRunner {
  return {
    currentSession: () => session,
    prepareModelCallInput: () => ({
      instructions: undefined,
      telemetryRuntimeContext: undefined,
    }),
    runOneModelCall: async () => result,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createFixture(overrides: Overrides = {}): {
  readonly calls: string[];
  readonly config: GenerateConfig;
  readonly services: StepServices;
} {
  const calls: string[] = [];
  const note = (value: string): void => {
    calls.push(value);
  };
  let currentSession = createSession();
  const result = successfulResult();
  const model = "test-model" satisfies LanguageModel;

  const config: GenerateConfig = {
    handleEvent:
      overrides.events === false
        ? undefined
        : async (event) => {
            note(`event.${event.type}`);
          },
    mode: "conversation",
    resolveModel: async () => model,
    tools: new Map(),
    ...overrides.config,
  };

  const services: StepServices = {
    ambient: {
      current: () => undefined,
      dynamicInstructionEntries: () => [],
      hasParentSession: () => false,
      isScheduleAuth: () => false,
      readToolInterrupt: () => undefined,
      skillAnnouncementEntry: () => undefined,
      ...overrides.ambient,
    },
    attachments: {
      hydrate: async (history) => history,
      stage: async (content) => {
        note("attachments.stage");
        return content;
      },
      ...overrides.attachments,
    },
    failure: {
      describe: ({ error }) => ({
        content: { code: "MODEL_CALL_FAILED", details: {}, message: errorMessage(error) },
        logFields: {},
        taskOutput: `task(${errorMessage(error)})`,
        upstreamMessage: undefined,
      }),
      describeStreamWrite: ({ error }) => ({
        content: { code: "STREAM_WRITE_FAILED", details: {}, message: errorMessage(error) },
        logFields: {},
      }),
      ...overrides.failure,
    },
    log: {
      error: (message) => note(`log.error(${message})`),
      warn: (message) => note(`log.warn(${message})`),
    },
    modelCall: {
      attributionHeaders: () => undefined,
      compact: async ({ history }) => history,
      continueWorkflowInterrupt: async () => {
        note("modelCall.continueWorkflowInterrupt");
        return null;
      },
      create: ({ prompt }) => {
        note("modelCall.create");
        currentSession = prompt.session;
        return createRunner(currentSession, result);
      },
      currentState: (runner) => runner.currentSession(),
      formatModelId: () => "test-model",
      prepareAttempt: (runner) => {
        note("modelCall.prepareAttempt");
        return runner.prepareModelCallInput();
      },
      recoveryStages: [],
      resolveActive: async ({ state }) => ({ model, state }),
      resolveCompaction: async () => ({ model, providerOptions: undefined }),
      run: async ({ runner }) => {
        note("modelCall.run");
        return runner.runOneModelCall({});
      },
      ...overrides.modelCall,
    },
    trace: {
      bind: ({ state }) => state,
      end: () => note("trace.end"),
      identity: { environment: "test", eveVersion: "0.0.0", functionId: "fn" },
      inContext: (_input, run) => run(),
      recordError: () => note("trace.recordError"),
      setAttribute: (_span, key, value) => note(`trace.setAttribute(${key},${value})`),
      start: () => undefined,
      ...overrides.trace,
    },
    usage: {
      publish: async () => note("usage.publish"),
      ...overrides.usage,
    },
  };

  return { calls, config, services };
}

function approvalSession(): HarnessSession {
  return setPendingInputBatch({
    event: { sequence: 3, stepIndex: 2, turnId: "approval-turn" },
    requests: [
      {
        action: {
          callId: "call-1",
          input: { command: "pwd" },
          kind: "tool-call",
          toolName: "bash",
        },
        display: "confirmation",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
        prompt: "Run bash?",
        requestId: "approval-1",
      },
    ],
    responseMessages: [],
    session: createSession(),
  });
}

function resolvedInput(overrides: Partial<StepInput> = {}) {
  return {
    effectiveInput: { message: "hi", ...overrides },
    emissionState: { sequence: 0, sessionStarted: false, stepIndex: 0, turnId: "turn_0" },
    history: [{ content: "prior", role: "user" }] satisfies ModelMessage[],
    state: createSession(),
  };
}

describe("resolveTurnInput", () => {
  it("parks before the model call when runtime actions are unresolved", async () => {
    const session = setPendingRuntimeActionBatch({
      actions: [{ callId: "call-1", input: {}, kind: "tool-call", toolName: "remote" }],
      event: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
      responseMessages: [],
      session: createSession(),
    });
    const { config, services } = createFixture();
    const resolution = await resolveTurnInput({
      config,
      input: { message: "hi" },
      services,
      state: session,
      trace: undefined,
    });
    expect(resolution).toMatchObject({
      kind: "settled",
      outcome: { action: "park", pendingRuntimeActionKeys: ["tool-call:remote:call-1"] },
    });
  });

  it("emits a preamble and epilogue before parking a deferred delivery", async () => {
    const { calls, config, services } = createFixture();
    const resolution = await resolveTurnInput({
      config,
      input: { message: "follow up" },
      services,
      state: approvalSession(),
      trace: undefined,
    });
    expect(resolution).toMatchObject({ kind: "settled", outcome: { action: "park" } });
    expect(calls).toEqual([
      "event.session.started",
      "event.turn.started",
      "event.message.received",
      "event.turn.completed",
      "event.session.waiting",
    ]);
  });

  it("parks silently on unresolved input without a fresh delivery", async () => {
    const { calls, config, services } = createFixture();
    const resolution = await resolveTurnInput({
      config,
      input: undefined,
      services,
      state: approvalSession(),
      trace: undefined,
    });
    expect(resolution).toMatchObject({ kind: "settled", outcome: { action: "park" } });
    expect(calls).toEqual([]);
  });

  it("settles when a session-limit continuation is denied", async () => {
    const limited = setTurnUsageState(createSession({ limits: { maxInputTokensPerSession: 5 } }), {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 5,
      outputTokens: 0,
      sawCost: false,
      session: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        inputTokens: 5,
        outputTokens: 0,
        sawCost: false,
      },
      turnId: "turn_0",
    });
    const request = createSessionLimitContinuationRequest({
      sessionId: limited.sessionId,
      totalUsedTokens: 5,
      violation: { kind: "input", limit: 5, usedTokens: 5 },
    });
    const session = setPendingInputBatch({
      requests: [request],
      responseMessages: [],
      session: limited,
    });
    const { config, services } = createFixture();
    const resolution = await resolveTurnInput({
      config,
      input: { inputResponses: [{ optionId: "stop", requestId: request.requestId }] },
      services,
      state: session,
      trace: undefined,
    });
    expect(resolution).toMatchObject({
      kind: "settled",
      outcome: { action: "done", output: "" },
    });
  });

  it("emits rejected approvals before the turn preamble and tags the trace", async () => {
    const span = trace.getTracer("test").startSpan("turn");
    const { calls, config, services } = createFixture();
    const resolution = await resolveTurnInput({
      config,
      input: {
        inputResponses: [{ optionId: "deny", requestId: "approval-1" }],
        message: "follow up",
      },
      services,
      state: approvalSession(),
      trace: span,
    });
    expect(resolution).toMatchObject({ deferredMessage: true, kind: "resolved" });
    expect(calls).toEqual([
      "event.action.result",
      "event.session.started",
      "event.turn.started",
      "event.message.received",
      "trace.setAttribute(eve.turn.id,turn_0)",
    ]);
    span.end();
  });

  it("skips lifecycle emission when no event sink is configured", async () => {
    const { calls, config, services } = createFixture({ events: false });
    const resolution = await resolveTurnInput({
      config,
      input: { message: "hi" },
      services,
      state: createSession(),
      trace: undefined,
    });
    expect(resolution.kind).toBe("resolved");
    expect(calls).toEqual([]);
  });
});

describe("assemblePrompt", () => {
  it("appends context and the staged delivery in order", async () => {
    const { config, services } = createFixture({
      attachments: { stage: async (content) => `staged:${String(content)}` },
    });
    const prompt = await assemblePrompt({
      config,
      resolved: resolvedInput({ context: ["c1", "c2"] }),
      services,
    });
    expect(prompt.messages).toEqual([
      { content: "prior", role: "user" },
      { content: "c1", role: "user" },
      { content: "c2", role: "user" },
      { content: "staged:hi", role: "user" },
    ]);
  });

  it("skips a deferred or already-consumed delivery", async () => {
    for (const flags of [{ consumedMessage: true }, { deferredMessage: true }]) {
      const { config, services } = createFixture();
      const prompt = await assemblePrompt({
        config,
        resolved: { ...resolvedInput(), ...flags },
        services,
      });
      expect(prompt.messages).toEqual([{ content: "prior", role: "user" }]);
    }
  });

  it("runs compaction request, replacement, reinjection, and completion in order", async () => {
    const { calls, config, services } = createFixture({
      config: { onCompaction: () => [{ content: "reinjected", role: "user" }] },
      modelCall: {
        compact: async () => [{ content: "summary", role: "user" }],
      },
    });
    const prompt = await assemblePrompt({
      config,
      resolved: {
        ...resolvedInput(),
        state: createSession({ compaction: { recentWindowSize: 10, threshold: 0 } }),
      },
      services,
    });

    expect(prompt.messages).toEqual([
      { content: "summary", role: "user" },
      { content: "reinjected", role: "user" },
    ]);
    expect(calls).toEqual([
      "attachments.stage",
      "event.compaction.requested",
      "event.compaction.completed",
    ]);
  });

  it("routes system sources and conditional delivery away from model messages", async () => {
    const ctx = new ContextContainer();
    const { config, services } = createFixture({
      ambient: {
        current: () => ctx,
        dynamicInstructionEntries: () => [{ content: "dynamic", role: "system" }],
        isScheduleAuth: () => true,
        skillAnnouncementEntry: () => ({ content: "skill", role: "system" }),
      },
    });
    const prompt = await assemblePrompt({
      config,
      resolved: {
        ...resolvedInput(),
        history: [
          { content: "base", role: "system" },
          { content: "prior", role: "user" },
        ],
      },
      services,
    });

    expect(prompt.emptyDeliveryEnabled).toBe(true);
    expect(prompt.modelMessages).toEqual([
      { content: "prior", role: "user" },
      { content: "hi", role: "user" },
    ]);
    expect(prompt.systemMessages.map((entry) => entry.content)).toEqual([
      "base",
      "dynamic",
      "skill",
      CONDITIONAL_DELIVERY_INSTRUCTION,
    ]);
  });
});

describe("generateStep", () => {
  const input = { input: { message: "hi" }, state: createSession() };

  it("runs preflight, call, accounting, publishing, and settlement in order", async () => {
    const { calls, config, services } = createFixture();
    const outcome = await generateStep({ config, services, ...input });

    expect(outcome).toMatchObject({ action: "park" });
    expect(calls).toEqual([
      "event.session.started",
      "event.turn.started",
      "event.message.received",
      "attachments.stage",
      "modelCall.create",
      "modelCall.prepareAttempt",
      "event.step.started",
      "modelCall.continueWorkflowInterrupt",
      "modelCall.run",
      "usage.publish",
      "event.turn.completed",
      "event.session.waiting",
    ]);
  });

  it("settles a pending workflow interrupt without a model call", async () => {
    const { calls, config, services } = createFixture({
      modelCall: {
        continueWorkflowInterrupt: async ({ prompt }) => ({
          action: "continue",
          state: prompt.session,
        }),
      },
    });
    await expect(generateStep({ config, services, ...input })).resolves.toMatchObject({
      action: "continue",
    });
    expect(calls).not.toContain("modelCall.run");
  });

  it("settles on the token limit without a model call", async () => {
    const session = setTurnUsageState(createSession({ limits: { maxInputTokensPerSession: 1 } }), {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 1,
      outputTokens: 0,
      sawCost: false,
      session: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        inputTokens: 1,
        outputTokens: 0,
        sawCost: false,
      },
      turnId: "turn_0",
    });
    const { calls, config, services } = createFixture();
    await expect(
      generateStep({ config, input: { message: "hi" }, services, state: session }),
    ).resolves.toMatchObject({ action: "park", hasPendingInputBatch: true });
    expect(calls).not.toContain("modelCall.run");
  });

  it("threads rewritten errors and retry options through recovery stages", async () => {
    const seen: string[] = [];
    const stages: readonly RecoveryStage[] = [
      async ({ error }) => {
        seen.push(`first:${errorMessage(error)}`);
        return {
          error: new Error("rewritten"),
          outcome: "failed",
          retryOptions: { extraSystemNote: "retry" },
        };
      },
      async ({ error, retryOptions }) => {
        seen.push(`second:${errorMessage(error)}:${retryOptions?.extraSystemNote}`);
        return { outcome: "recovered", result: successfulResult("recovered") };
      },
    ];
    const { config, services } = createFixture({
      modelCall: { recoveryStages: stages, run: async () => Promise.reject(new Error("boom")) },
    });

    await expect(generateStep({ config, services, ...input })).resolves.toMatchObject({
      action: "park",
    });
    expect(seen).toEqual(["first:boom", "second:rewritten:retry"]);
  });

  it("records the trace failure and rethrows without an event sink", async () => {
    const span = trace.getTracer("test").startSpan("turn");
    const boom = new Error("boom");
    const { calls, config, services } = createFixture({
      events: false,
      modelCall: { run: async () => Promise.reject(boom) },
      trace: { start: () => span },
    });

    await expect(generateStep({ config, services, ...input })).rejects.toBe(boom);
    expect(calls).toContain("trace.recordError");
  });

  it("parks a stream-write failure in task mode", async () => {
    const error = new Error("Stream write failed: HTTP 504 (PUT https://stream)");
    const { config, services } = createFixture({
      config: { mode: "task" },
      modelCall: { run: async () => Promise.reject(error) },
    });
    await expect(generateStep({ config, services, ...input })).resolves.toMatchObject({
      action: "park",
    });
  });

  it("completes terminal task failures as error results", async () => {
    const error = Object.assign(new Error("bad request"), { statusCode: 400 });
    const { config, services } = createFixture({
      config: { mode: "task" },
      modelCall: { run: async () => Promise.reject(error) },
    });
    await expect(generateStep({ config, services, ...input })).resolves.toMatchObject({
      action: "done",
      isError: true,
      output: "task(bad request)",
    });
  });

  it("completes terminal conversation failures with empty output", async () => {
    const error = Object.assign(new Error("bad request"), { statusCode: 400 });
    const { config, services } = createFixture({
      modelCall: { run: async () => Promise.reject(error) },
    });
    await expect(generateStep({ config, services, ...input })).resolves.toMatchObject({
      action: "done",
      output: "",
    });
  });

  it("prefers the recognized terminal log line", async () => {
    const error = Object.assign(new Error("bad request"), { statusCode: 400 });
    const { calls, config, services } = createFixture({
      failure: {
        describe: () => ({
          content: { code: "KNOWN", details: {}, message: "known" },
          logFields: {},
          recognizedTerminal: { fields: {}, message: "KnownError: fix config" },
          taskOutput: "known",
          upstreamMessage: undefined,
        }),
      },
      modelCall: { run: async () => Promise.reject(error) },
    });
    await generateStep({ config, services, ...input });
    expect(calls).toContain("log.error(KnownError: fix config)");
  });

  it("rethrows a recoverable task failure for durable retry", async () => {
    const error = new Error("recoverable");
    const { config, services } = createFixture({
      config: { mode: "task" },
      modelCall: { run: async () => Promise.reject(error) },
    });
    await expect(generateStep({ config, services, ...input })).rejects.toBe(error);
  });

  it("fails a task after empty-response recovery is exhausted", async () => {
    const { config, services } = createFixture({
      config: { mode: "task" },
      modelCall: {
        run: async () => Promise.reject(new EmptyModelResponseError()),
      },
    });
    await expect(generateStep({ config, services, ...input })).resolves.toMatchObject({
      action: "done",
      isError: true,
    });
  });

  it("parks a conversation on a non-terminal failure", async () => {
    const error = Object.assign(new Error("overloaded"), { statusCode: 503 });
    const { config, services } = createFixture({
      modelCall: { run: async () => Promise.reject(error) },
    });
    await expect(generateStep({ config, services, ...input })).resolves.toMatchObject({
      action: "park",
    });
  });

  it("opens, binds, enters, and ends the turn trace around a delivery", async () => {
    const span = trace.getTracer("test").startSpan("turn");
    const seen: string[] = [];
    const { config, services } = createFixture({
      trace: {
        bind: ({ state }) => {
          seen.push("bind");
          return state;
        },
        end: () => seen.push("end"),
        inContext: (_context, run) => {
          seen.push("context");
          return run();
        },
        start: (name, attributes) => {
          seen.push(
            `${name}:${attributes["eve.session.id"]}:${attributes["ai.telemetry.functionId"]}`,
          );
          return span;
        },
      },
    });
    await generateStep({ config, services, ...input });
    expect(seen).toEqual(["ai.eve.turn:session:fn", "bind", "context", "end"]);
  });

  it("does not open a trace for a continuation step", async () => {
    const { config, services } = createFixture({
      trace: {
        start: () => {
          throw new Error("continuations do not open turn traces");
        },
      },
    });
    await expect(
      generateStep({ config, input: undefined, services, state: createSession() }),
    ).resolves.toMatchObject({ action: "park" });
  });
});
