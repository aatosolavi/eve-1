import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import {
  CallbackBaseUrlKey,
  PendingAuthorizationResultKey,
  setPendingAuthorization,
} from "#core/authorization.js";
import { ContinuationTokenKey, ModeKey } from "#core/context/keys.js";
import { createDurableSessionState, type DurableSession } from "#core/durable-session-store.js";
import type { EntryServices, StepEntryInput } from "#core/entrypoint.js";
import { runStepEntrypoint } from "#core/index.js";
import { createStepStartedEvent, createTurnStartedEvent } from "#core/protocol/message.js";
import type { RuntimeActionResult } from "#core/actions/types.js";
import type { JsonObject } from "#core/shared/json.js";
import { setTurnUsageState } from "#core/turn-tag-state.js";
import { TurnCancelledError } from "#core/turn-cancellation.js";
import type { LoopMode } from "#core/types.js";
import type { HarnessSession } from "#harness/types.js";

type Group<K extends keyof EntryServices> = Partial<EntryServices[K]>;

interface Overrides {
  readonly agentOutputSchema?: JsonObject;
  readonly cancellation?: Group<"cancellation">;
  readonly channel?: Group<"channel">;
  readonly generate?: EntryServices["generate"];
  readonly hooks?: Group<"hooks">;
  readonly mode?: LoopMode;
  readonly scope?: Group<"scope">;
  readonly sessions?: Group<"sessions">;
  readonly stream?: Group<"stream">;
}

function createServices(overrides: Overrides = {}): {
  readonly calls: string[];
  readonly services: EntryServices;
} {
  const calls: string[] = [];
  const note = (value: string) => calls.push(value);
  const writer = new WritableStream<Uint8Array>().getWriter();

  const base: EntryServices = {
    cancellation: {
      abortSignal: undefined,
    },
    channel: {
      async deliver(_ctx, payload) {
        note(`channel.deliver(${String(payload.message)})`);
        return payload.message === undefined
          ? undefined
          : { message: payload.message, outputSchema: payload.outputSchema };
      },
      pinAdapterState: () => note("channel.pinAdapterState"),
      async transformEvent(_ctx, event) {
        note(`channel.transform(${event.type})`);
        return event;
      },
    },
    codec: {
      async restore() {
        const ctx = new ContextContainer();
        ctx.set(ModeKey, overrides.mode ?? "conversation");
        return {
          agentOutputSchema: overrides.agentOutputSchema,
          ctx,
        };
      },
      serialize: () => ({ serialized: "out" }),
    },
    async generate({ input, session }) {
      return {
        action: "done",
        output: input?.message,
        state: withSystemSuffix(session, "generated"),
      };
    },
    hooks: {
      async dispatchDynamicInstructions(_ctx, event) {
        note(`hooks.instructions(${event.type})`);
      },
      async dispatchDynamicModel(_ctx, event) {
        note(`hooks.model(${event.type})`);
      },
      async dispatchDynamicSkills(_ctx, event) {
        note(`hooks.skills(${event.type})`);
      },
      async dispatchDynamicTools(_ctx, event) {
        note(`hooks.tools(${event.type})`);
      },
      async dispatchStreamHooks(_ctx, event) {
        note(`hooks.stream(${event.type})`);
      },
      recordChildUsageSpans: () => note("hooks.recordChildUsageSpans"),
    },
    scope: {
      run: (_ctx, session, fn) => fn(session),
    },
    sessions: {
      hydrate: (_ctx, durable) =>
        makeSession({
          continuationToken: durable.continuationToken,
          state: durable.state,
          system: durable.agent.system,
        }),
      refresh: (_ctx, session) => withSystemSuffix(session, "refreshed"),
    },
    stream: {
      async close() {
        note("stream.close");
      },
      open() {
        note("stream.open");
        return writer;
      },
      release: () => note("stream.release"),
      async write(_writer, event) {
        const name = event.type === "authorization.completed" ? `:${event.data.name}` : "";
        note(`stream.write(${event.type}${name})`);
      },
    },
  };

  return {
    calls,
    services: {
      ...base,
      cancellation: { ...base.cancellation, ...overrides.cancellation },
      channel: { ...base.channel, ...overrides.channel },
      generate: overrides.generate ?? base.generate,
      hooks: { ...base.hooks, ...overrides.hooks },
      scope: { ...base.scope, ...overrides.scope },
      sessions: { ...base.sessions, ...overrides.sessions },
      stream: { ...base.stream, ...overrides.stream },
    },
  };
}

function makeSession(
  input: {
    readonly continuationToken?: string;
    readonly state?: HarnessSession["state"];
    readonly system?: string;
  } = {},
): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: input.system ?? "hydrated",
      tools: [],
    },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: input.continuationToken ?? "token",
    history: [],
    sessionId: "session",
    state: input.state,
  };
}

function withSystemSuffix(session: HarnessSession, suffix: string): HarnessSession {
  return {
    ...session,
    agent: {
      ...session.agent,
      system: `${session.agent.system}+${suffix}`,
    },
  };
}

function makeDurable(state?: DurableSession["state"]): DurableSession {
  return {
    agent: { system: "hydrated" },
    continuationToken: "token",
    history: [],
    sessionId: "session",
    state,
  };
}

function entryInput(
  turnInput: StepEntryInput["turnInput"],
  durableSession = makeDurable(),
): StepEntryInput {
  return {
    callbackBaseUrl: undefined,
    durableSession,
    durableSnapshot: createDurableSessionState({ session: makeSession() }),
    serializedContext: { serialized: "in" },
    turnInput,
  };
}

const deliver = (...messages: readonly string[]): StepEntryInput["turnInput"] => ({
  kind: "deliver",
  payloads: messages.map((message) => ({ message })),
});

describe("runStepEntrypoint", () => {
  it("folds each delivery payload, closes done streams, and reports session totals", async () => {
    const { calls, services } = createServices({
      generate: async ({ ctx, input, session }) => {
        expect(ctx.get(CallbackBaseUrlKey)).toBe("https://example.test");
        expect(input?.message).toBe("first\n\nsecond");
        const usage = {
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          costUsd: 0,
          inputTokens: 10,
          outputTokens: 5,
          sawCost: false,
        };
        return {
          action: "done",
          output: "complete",
          state: setTurnUsageState(session, {
            ...usage,
            session: usage,
            turnId: "turn_0",
          }),
        };
      },
    });
    const input = {
      ...entryInput(deliver("first", "second")),
      callbackBaseUrl: "https://example.test",
    };

    const outcome = await runStepEntrypoint(services, input);

    expect(outcome).toMatchObject({
      action: "done",
      output: "complete",
      usage: {
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        inputTokens: 10,
        outputTokens: 5,
      },
    });
    expect(outcome.state.durable.snapshot?.session.agent.system).toBe("hydrated+refreshed");
    expect(calls).toEqual([
      "channel.deliver(first)",
      "channel.deliver(second)",
      "channel.pinAdapterState",
      "stream.open",
      "stream.close",
    ]);
  });

  it("strips matched and unmatched authorization callbacks before generation", async () => {
    const pendingState = setPendingAuthorization(undefined, {
      challenges: [
        {
          challenge: { displayName: "Known" },
          hookUrl: "https://example.test/auth",
          name: "known",
          resume: { verifier: "secret" },
        },
      ],
    });
    const durable = makeDurable(pendingState);
    const seenInputs: unknown[] = [];
    const { calls, services } = createServices({
      generate: async ({ ctx, input, session }) => {
        seenInputs.push(input);
        expect(ctx.get(PendingAuthorizationResultKey)).toEqual([
          {
            callback: { method: "GET", params: { code: "abc" } },
            hookUrl: "https://example.test/auth",
            name: "known",
            resume: { verifier: "secret" },
          },
        ]);
        return { action: "done", output: "", state: session };
      },
    });
    const input = entryInput(
      {
        kind: "deliver",
        payloads: [
          authorizationPayload("known"),
          authorizationPayload("unknown"),
          { message: "plain" },
        ],
      },
      durable,
    );

    await runStepEntrypoint(services, input);

    expect(seenInputs).toEqual([{ message: "plain" }]);
    expect(calls).toContain("channel.deliver(plain)");
    expect(calls).not.toContain("channel.deliver(undefined)");
    expect(calls.indexOf("stream.write(authorization.completed:known)")).toBeLessThan(
      calls.indexOf("stream.close"),
    );
  });

  it("reuses the durable snapshot when an inline-handled delivery leaves the session unchanged", async () => {
    const { calls, services } = createServices({
      channel: { deliver: async () => undefined },
    });
    const input = entryInput(deliver("inline"));

    const outcome = await runStepEntrypoint(services, input);

    expect(outcome.action).toBe("park");
    expect(outcome.state.durable).toBe(input.durableSnapshot);
    expect(calls).not.toContain("stream.open");
  });

  it("snapshots an inline-handled delivery when the channel rekeys the session", async () => {
    const { services } = createServices({
      channel: {
        async deliver(ctx) {
          ctx.set(ContinuationTokenKey, "rekeyed");
          return undefined;
        },
      },
    });
    const input = entryInput(deliver("inline"));

    const outcome = await runStepEntrypoint(services, input);

    expect(outcome.state.durable).not.toBe(input.durableSnapshot);
    expect(outcome.state.durable.continuationToken).toBe("rekeyed");
  });

  it("folds child results into step input and records their usage spans", async () => {
    const result: RuntimeActionResult = {
      callId: "call",
      kind: "tool-result",
      output: "child",
      toolName: "tool",
    };
    const seen: unknown[] = [];
    const { calls, services } = createServices({
      generate: async ({ input, session }) => {
        seen.push(input);
        return { action: "continue", state: session };
      },
    });

    const outcome = await runStepEntrypoint(
      services,
      entryInput({ kind: "runtime-action-result", results: [result] }),
    );

    expect(seen).toEqual([{ runtimeActionResults: [result] }]);
    expect(calls).toContain("hooks.recordChildUsageSpans");
    expect(outcome.action).toBe("continue");
  });

  it("settles cancellation over the unchanged input cursors", async () => {
    const { calls, services } = createServices({
      generate: async () => {
        throw new TurnCancelledError();
      },
    });
    const input = entryInput(deliver("cancel"));

    const outcome = await runStepEntrypoint(services, input);

    expect(outcome).toEqual({
      action: "cancelled",
      state: {
        durable: input.durableSnapshot,
        serializedContext: input.serializedContext,
      },
    });
    expect(calls).toContain("stream.release");
    expect(calls).not.toContain("stream.close");
  });

  it("releases non-done streams and projects the classified state", async () => {
    const { calls, services } = createServices({
      generate: async ({ session }) => ({
        action: "park",
        hasPendingAuthorization: true,
        hasPendingInputBatch: false,
        state: session,
      }),
    });

    const outcome = await runStepEntrypoint(services, entryInput(deliver("park")));

    expect(outcome).toMatchObject({
      action: "park",
      hasPendingAuthorization: true,
      state: { serializedContext: { serialized: "out" } },
    });
    expect(outcome.state.durable.snapshot?.session.agent.system).toBe("hydrated+refreshed");
    expect(calls).toContain("stream.release");
  });

  it("composes event transformation, writing, and hook dispatch in order", async () => {
    const { calls, services } = createServices({
      generate: async ({ handleEvent, session }) => {
        await handleEvent(createStepStartedEvent({ sequence: 0, stepIndex: 0, turnId: "turn_0" }));
        await handleEvent(createTurnStartedEvent({ sequence: 0, turnId: "turn_0" }));
        return { action: "done", output: "", state: session };
      },
    });

    await runStepEntrypoint(services, entryInput(deliver("events")));

    expect(calls.filter(isEventCall)).toEqual([
      "channel.transform(step.started)",
      "stream.write(step.started)",
      "hooks.stream(step.started)",
      "hooks.tools(step.started)",
      "hooks.skills(step.started)",
      "hooks.instructions(step.started)",
      "channel.transform(turn.started)",
      "stream.write(turn.started)",
      "hooks.stream(turn.started)",
      "hooks.model(turn.started)",
      "hooks.tools(turn.started)",
      "hooks.skills(turn.started)",
      "hooks.instructions(turn.started)",
    ]);
  });

  describe("output-schema precedence", () => {
    it("a run-scoped schema always wins", async () => {
      const schema = await generatedSchema({
        agentOutputSchema: { source: "agent" },
        mode: "task",
        runScopedSchema: { source: "run" },
      });

      expect(schema).toEqual({ source: "run" });
    });

    it("a task adopts the agent schema when no schema is already active", async () => {
      const schema = await generatedSchema({
        agentOutputSchema: { source: "agent" },
        mode: "task",
      });

      expect(schema).toEqual({ source: "agent" });
    });

    it("a conversation without a run-scoped schema enforces nothing", async () => {
      const schema = await generatedSchema({
        agentOutputSchema: { source: "agent" },
        mode: "conversation",
      });

      expect(schema).toBeUndefined();
    });
  });
});

function authorizationPayload(connectionName: string) {
  return {
    authorizationCallback: {
      callback: {
        method: "GET",
        params: { code: "abc" },
      },
      connectionName,
    },
  };
}

function isEventCall(call: string): boolean {
  return (
    call.startsWith("channel.transform") ||
    call.startsWith("stream.write") ||
    call.startsWith("hooks.")
  );
}

async function generatedSchema(input: {
  readonly agentOutputSchema: JsonObject;
  readonly mode: LoopMode;
  readonly runScopedSchema?: JsonObject;
}): Promise<JsonObject | undefined> {
  let seen: JsonObject | undefined;
  const { services } = createServices({
    agentOutputSchema: input.agentOutputSchema,
    generate: async ({ session }) => {
      seen = session.outputSchema;
      return { action: "done", output: "", state: session };
    },
    mode: input.mode,
  });
  const turnInput: StepEntryInput["turnInput"] = {
    kind: "deliver",
    payloads: [{ message: "schema", outputSchema: input.runScopedSchema }],
  };

  await runStepEntrypoint(services, entryInput(turnInput));
  return seen;
}
