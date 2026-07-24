import { describe, expect, it } from "vitest";

import type { EntryFlowTypes, EntryPorts } from "#core/entrypoint.js";
import { runStepEntrypoint } from "#core/index.js";

/**
 * Minimal concrete binding: every payload is a tagged string; the turn
 * input mirrors the deliver / child-results union structurally.
 */
interface TestEntry extends EntryFlowTypes {
  readonly authCallback: string;
  readonly authCompletion: string;
  readonly context: string;
  readonly deliveryPayload: string;
  readonly durableSession: string;
  readonly durableState: string;
  readonly emissionState: string;
  readonly event: string;
  readonly messages: readonly string[];
  readonly outputSchema: string;
  readonly pendingAuthorization: string;
  readonly serializedContext: string;
  readonly session: string;
  readonly stepInput: string;
  readonly turnInput:
    | { readonly kind: "deliver"; readonly payloads: readonly string[] }
    | { readonly kind: "runtime-action-result"; readonly results: readonly string[] };
  readonly usage: string;
  readonly writer: string;
}

type Group<K extends keyof EntryPorts<TestEntry>> = Partial<EntryPorts<TestEntry>[K]>;

interface Overrides {
  readonly auth?: Group<"auth">;
  readonly channel?: Group<"channel">;
  readonly contexts?: Group<"contexts">;
  readonly generate?: EntryPorts<TestEntry>["generate"];
  readonly hooks?: Group<"hooks">;
  readonly schema?: Group<"schema">;
  readonly sessions?: Group<"sessions">;
  readonly usage?: Group<"usage">;
}

function createPorts(over: Overrides = {}): {
  readonly calls: string[];
  readonly ports: EntryPorts<TestEntry>;
} {
  const calls: string[] = [];
  const note = (name: string) => calls.push(name);

  const ports: EntryPorts<TestEntry> = {
    auth: {
      callbackOf: (payload) => (payload.startsWith("cb:") ? payload.slice(3) : undefined),
      clearPending: (durable, names) => `${durable}-cleared(${names.join(",")})`,
      completedEvent: ({ completion, emissionState }) =>
        `auth-completed(${completion},${emissionState})`,
      match: (pending, callback) =>
        callback === "known"
          ? { completion: `comp(${pending})`, name: "known", result: `res(${callback})` }
          : undefined,
      pendingOf: () => undefined,
      stash: (_ctx, results) => note(`auth.stash(${results.join(",")})`),
      ...over.auth,
    },
    cancellation: {
      assertNotAborted: () => {},
      isCancellation: (error) => error instanceof Error && error.message === "cancelled",
    },
    channel: {
      coalesce: (first, second) => `${first}+${second}`,
      deliver: async (_ctx, payload) => `in(${payload})`,
      pinAdapterState: () => note("channel.pinAdapterState"),
      transformEvent: async (_ctx, event) => `adapted(${event})`,
      ...over.channel,
    },
    codec: {
      restore: async (serialized) => `ctx(${serialized})`,
      serialize: () => "serialized-out",
    },
    contexts: {
      applyDeliveryAuth: () => note("contexts.applyDeliveryAuth"),
      modeOf: () => "conversation",
      seedCallbackBaseUrl: (_ctx, url) => note(`contexts.seedCallbackBaseUrl(${url})`),
      ...over.contexts,
    },
    generate:
      over.generate ??
      (async ({ input, session }) => ({
        action: "done",
        output: `out(${String(input)})`,
        state: `${session}+gen`,
      })),
    hooks: {
      dispatchDynamicInstructions: async (_ctx, event) => {
        note(`hooks.instructions(${event})`);
      },
      dispatchDynamicModel: async (_ctx, event) => {
        note(`hooks.model(${event})`);
      },
      dispatchDynamicSkills: async (_ctx, event) => {
        note(`hooks.skills(${event})`);
      },
      dispatchDynamicTools: async (_ctx, event) => {
        note(`hooks.tools(${event})`);
      },
      dispatchStreamHooks: async (_ctx, event) => {
        note(`hooks.stream(${event})`);
      },
      isStepStarted: (event) => event.includes("step.started"),
      ...over.hooks,
    },
    schema: {
      agentSchemaOf: () => undefined,
      hasSchema: (session) => session.includes("+schema"),
      runScopedOf: () => undefined,
      withSchema: (session, schema) => `${session}+schema(${schema})`,
      ...over.schema,
    },
    scope: {
      run: (_ctx, session, fn) => fn(session),
    },
    sessions: {
      classifyParked: (session) => ({
        action: "park",
        hasPendingAuthorization: false,
        hasPendingInputBatch: false,
        state: session,
      }),
      hydrate: (_ctx, durable) => `sess(${durable})`,
      readEmission: (session) => `em(${session})`,
      reconcileToken: (_ctx, session) => session,
      refresh: (_ctx, session) => `${session}+refreshed`,
      snapshot: (session) => `snap(${session})`,
      ...over.sessions,
    },
    stream: {
      close: async (writer) => {
        note(`stream.close(${writer})`);
      },
      open: () => {
        note("stream.open");
        return "W";
      },
      release: (writer) => {
        note(`stream.release(${writer})`);
      },
      write: async (writer, event) => {
        note(`stream.write(${writer},${event})`);
      },
    },
    turnInputs: {
      asChildResultInput: (turnInput) =>
        turnInput.kind === "runtime-action-result"
          ? `children(${turnInput.results.join(",")})`
          : "",
      isChildResults: (turnInput) => turnInput?.kind === "runtime-action-result",
      isDelivery: (turnInput) => turnInput?.kind === "deliver",
      payloadsOf: (turnInput) => (turnInput.kind === "deliver" ? turnInput.payloads : []),
      withPayloads: (turnInput, payloads) =>
        turnInput.kind === "deliver" ? { kind: "deliver", payloads } : turnInput,
    },
    usage: {
      recordChildSpans: () => note("usage.recordChildSpans"),
      sessionTotalsOf: (session) => `totals(${session})`,
      ...over.usage,
    },
  };
  return { calls, ports };
}

function entryInput(
  turnInput: TestEntry["turnInput"] | undefined,
  callbackBaseUrl?: string,
): Parameters<typeof runStepEntrypoint<TestEntry>>[1] {
  return {
    callbackBaseUrl,
    durableSession: "durable",
    durableSnapshot: "rawsnap",
    serializedContext: "serialized-in",
    turnInput,
  };
}

const deliver = (payloads: readonly string[]): TestEntry["turnInput"] => ({
  kind: "deliver",
  payloads,
});

describe("runStepEntrypoint", () => {
  it("resolves the delivery, runs the step, and projects the done outcome", async () => {
    const { calls, ports } = createPorts();

    const outcome = await runStepEntrypoint(ports, entryInput(deliver(["p1", "p2"]), "http://cb"));

    // Coalesced payloads flow into generate over the refreshed session; the
    // done arm carries session totals, the closed stream, and the snapshot
    // of the token-reconciled session.
    expect(outcome).toEqual({
      action: "done",
      isError: undefined,
      output: "out(in(p1)+in(p2))",
      state: { durable: "snap(sess(durable)+refreshed+gen)", serializedContext: "serialized-out" },
      usage: "totals(sess(durable)+refreshed+gen)",
    });
    expect(calls).toEqual([
      "contexts.seedCallbackBaseUrl(http://cb)",
      "contexts.applyDeliveryAuth",
      "channel.pinAdapterState",
      "stream.open",
      "stream.close(W)",
    ]);
  });

  it("completes matched authorization callbacks and strips their payloads", async () => {
    const events: string[] = [];
    const { calls, ports } = createPorts({
      auth: { pendingOf: (durable) => `PENDING(${durable})` },
      generate: async ({ input, session }) => {
        events.push(`generate(${String(input)},${session})`);
        return { action: "done", output: "", state: session };
      },
    });

    await runStepEntrypoint(ports, entryInput(deliver(["cb:known", "cb:unknown", "plain"])));

    // Matched callback: stashed, cleared from the durable session, its
    // completion emitted through the composed handler before generate.
    // Unmatched callback: consumed without completing anything. Only the
    // plain payload reaches the adapter.
    expect(calls).toContain("auth.stash(res(known))");
    expect(calls).toContain(
      "stream.write(W,adapted(auth-completed(comp(PENDING(durable)),em(sess(durable-cleared(known))))))",
    );
    expect(events).toEqual(["generate(in(plain),sess(durable-cleared(known))+refreshed)"]);
  });

  it("re-parks without a model turn when the adapter handled the delivery inline", async () => {
    const { calls, ports } = createPorts({ channel: { deliver: async () => null } });

    const outcome = await runStepEntrypoint(ports, entryInput(deliver(["p1"])));

    // Session unchanged: the raw input snapshot is reused, no writer opens.
    expect(outcome).toEqual({
      action: "park",
      authorizationNames: undefined,
      hasPendingAuthorization: false,
      hasPendingInputBatch: false,
      pendingRuntimeActionKeys: undefined,
      state: { durable: "rawsnap", serializedContext: "serialized-out" },
    });
    expect(calls).not.toContain("stream.open");
  });

  it("snapshots the inline-handled session when a handler rekeyed it", async () => {
    const { ports } = createPorts({
      channel: { deliver: async () => null },
      sessions: { reconcileToken: (_ctx, session) => `${session}+rekeyed` },
    });

    const outcome = await runStepEntrypoint(ports, entryInput(deliver(["p1"])));

    expect(outcome).toMatchObject({
      state: { durable: "snap(sess(durable)+rekeyed)" },
    });
  });

  it("folds child results back in and records their usage spans", async () => {
    const events: string[] = [];
    const { calls, ports } = createPorts({
      generate: async ({ input, session }) => {
        events.push(String(input));
        return { action: "continue", state: session };
      },
    });

    const outcome = await runStepEntrypoint(
      ports,
      entryInput({ kind: "runtime-action-result", results: ["r1", "r2"] }),
    );

    expect(calls).toContain("usage.recordChildSpans");
    expect(events).toEqual(["children(r1,r2)"]);
    expect(outcome).toMatchObject({ action: "continue" });
  });

  it("settles a cancellation over the unchanged input cursors", async () => {
    const { calls, ports } = createPorts({
      generate: async () => {
        throw new Error("cancelled");
      },
    });

    const outcome = await runStepEntrypoint(ports, entryInput(deliver(["p1"])));

    expect(outcome).toEqual({
      action: "cancelled",
      state: { durable: "rawsnap", serializedContext: "serialized-in" },
    });
    expect(calls).toContain("stream.release(W)");
    expect(calls).not.toContain("stream.close(W)");
  });

  it("releases the writer and re-states a parked outcome", async () => {
    const { calls, ports } = createPorts({
      generate: async ({ session }) => ({
        action: "park",
        hasPendingAuthorization: true,
        hasPendingInputBatch: false,
        state: session,
      }),
    });

    const outcome = await runStepEntrypoint(ports, entryInput(deliver(["p1"])));

    expect(outcome).toMatchObject({
      action: "park",
      hasPendingAuthorization: true,
      state: {
        durable: "snap(sess(durable)+refreshed)",
        serializedContext: "serialized-out",
      },
    });
    expect(calls).toContain("stream.release(W)");
  });

  it("dispatches each emitted event in order, skipping dynamic model for step.started", async () => {
    const { calls, ports } = createPorts({
      generate: async ({ handleEvent, session }) => {
        await handleEvent("step.started", ["m"]);
        await handleEvent("text", ["m"]);
        return { action: "done", output: "", state: session };
      },
    });

    await runStepEntrypoint(ports, entryInput(deliver(["p1"])));

    const dispatches = calls.filter(
      (call) => call.startsWith("stream.write") || call.startsWith("hooks."),
    );
    expect(dispatches).toEqual([
      "stream.write(W,adapted(step.started))",
      "hooks.stream(adapted(step.started))",
      "hooks.tools(adapted(step.started))",
      "hooks.skills(adapted(step.started))",
      "hooks.instructions(adapted(step.started))",
      "stream.write(W,adapted(text))",
      "hooks.stream(adapted(text))",
      "hooks.model(adapted(text))",
      "hooks.tools(adapted(text))",
      "hooks.skills(adapted(text))",
      "hooks.instructions(adapted(text))",
    ]);
  });

  describe("output-schema precedence", () => {
    const sessionSeen = (over: Overrides): Promise<string> => {
      const seen: string[] = [];
      const { ports } = createPorts({
        ...over,
        generate: async ({ session }) => {
          seen.push(session);
          return { action: "done", output: "", state: session };
        },
      });
      return runStepEntrypoint(ports, entryInput(deliver(["p1"]))).then(() => seen[0] ?? "");
    };

    it("a run-scoped schema always wins", async () => {
      const session = await sessionSeen({
        contexts: { modeOf: () => "task" },
        schema: { agentSchemaOf: () => "agent", runScopedOf: () => "run" },
      });
      expect(session).toBe("sess(durable)+schema(run)+refreshed");
    });

    it("a task run adopts the agent schema when none is run-scoped", async () => {
      const session = await sessionSeen({
        contexts: { modeOf: () => "task" },
        schema: { agentSchemaOf: () => "agent" },
      });
      expect(session).toBe("sess(durable)+schema(agent)+refreshed");
    });

    it("a conversation with no run-scoped schema enforces nothing", async () => {
      const session = await sessionSeen({ schema: { agentSchemaOf: () => "agent" } });
      expect(session).toBe("sess(durable)+refreshed");
    });
  });
});
