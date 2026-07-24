import { afterEach, describe, expect, it, vi } from "vitest";
import { resumeHook, start } from "#internal/workflow/runtime.js";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { taskCommandHookToken, type TaskCommandHookPayload } from "#execution/tasks/commands.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { RouteContext } from "#public/definitions/channel.js";
import { handleSessionCallbackRequest } from "#runtime/session-callback-route.js";
import type { InputRequest } from "#runtime/input/types.js";

/**
 * End-to-end Slice 1 coverage: background election → placeholder →
 * park → executor transition → loopback notification POST through the
 * real callback route → driver wake → the two routing arms.
 *
 * The internal env gate (`EVE_INTERNAL_BACKGROUND_TASK_ELECTION`) is
 * the Slice 1 elector; the test plays the executor by resuming the
 * task actor's command hook directly.
 */

interface CapturedCallbackPost {
  readonly body: { kind?: string };
  readonly status: number;
  readonly url: string;
}

function installLoopbackCallbackFetch(): CapturedCallbackPost[] {
  const original = globalThis.fetch;
  const posts: CapturedCallbackPost[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const target = String(url);
      const match = /\/eve\/v1\/callback\/([^/?]+)/.exec(target);
      if (match?.[1] === undefined) {
        return original(url as never, init as never);
      }
      const token = decodeURIComponent(match[1]);
      const response = await handleSessionCallbackRequest(
        new Request(target, { body: init?.body, headers: init?.headers, method: "POST" }),
        createRouteContext({ token }),
      );
      posts.push({
        body: JSON.parse(String(init?.body)) as { kind?: string },
        status: response.status,
        url: target,
      });
      return response;
    },
  );
  return posts;
}

function createRouteContext(params: Record<string, string>): RouteContext {
  return {
    agent: {
      async cancelTurn() {
        throw new Error("unexpected cancelTurn");
      },
      async deliver() {
        throw new Error("unexpected deliver");
      },
      async getEventStream() {
        throw new Error("unexpected getEventStream");
      },
      async run() {
        throw new Error("unexpected run");
      },
    },
    params,
    requestIp: null,
    waitUntil() {},
  };
}

function buildSerializedContext(overrides: { continuationToken: string }): Record<string, unknown> {
  return {
    "eve.auth": {
      attributes: {},
      authenticator: "test-idp",
      principalId: "user-initiator",
      principalType: "user",
    },
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": { kind: "http", state: {} },
    "eve.continuationToken": overrides.continuationToken,
    "eve.mode": "conversation",
  };
}

async function waitForPosts(posts: readonly CapturedCallbackPost[], count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (posts.length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${count} callback POSTs (saw ${posts.length}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function sendTaskCommand(taskId: string, payload: TaskCommandHookPayload): Promise<void> {
  // The actor creates its hook right before its first snapshot; retry
  // briefly in case the hook's persistence trails the snapshot read.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await resumeHook(taskCommandHookToken(taskId), payload);
      return;
    } catch (error) {
      if (attempt >= 20) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function extractTaskId(events: readonly HandleMessageStreamEvent[]): string {
  for (const event of filterEventsByType(events, "action.result")) {
    const result = (event.data as { result?: { output?: { taskId?: unknown } } }).result;
    if (typeof result?.output?.taskId === "string") {
      return result.output.taskId;
    }
  }
  throw new Error("Expected an action.result event carrying a CreateTaskResult placeholder.");
}

interface CapturedEventStream {
  dispose(): void;
  nextUntil(
    label: string,
    predicate: (event: HandleMessageStreamEvent) => boolean,
  ): Promise<HandleMessageStreamEvent[]>;
}

function captureEvents(run: { readable: ReadableStream<Uint8Array> }): CapturedEventStream {
  const reader = run.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let disposed = false;

  const readUntil = async (
    predicate: (event: HandleMessageStreamEvent) => boolean,
  ): Promise<HandleMessageStreamEvent[]> => {
    const events: HandleMessageStreamEvent[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("Workflow stream closed before reaching the expected event.");
      }
      buffer += decoder.decode(value);
      for (
        let newlineIndex = buffer.indexOf("\n");
        newlineIndex !== -1;
        newlineIndex = buffer.indexOf("\n")
      ) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length === 0) {
          continue;
        }
        const event = JSON.parse(line) as HandleMessageStreamEvent;
        events.push(event);
        if (predicate(event)) {
          return events;
        }
      }
    }
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      reader.releaseLock();
    },
    async nextUntil(label, predicate) {
      if (disposed) {
        throw new Error("CapturedEventStream: stream already disposed.");
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          readUntil(predicate),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`Timed out waiting for ${label}.`)),
              15_000,
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    },
  };
}

const taskInputRequest: InputRequest = {
  action: { callId: "call_task_hitl", input: {}, kind: "tool-call", toolName: "pick_region" },
  prompt: "Which region should the research cover?",
  requestId: "req_task_region",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("task notifications integration", () => {
  it("elects background, parks, and wakes with the terminal outcome as input", async () => {
    vi.stubEnv("EVE_INTERNAL_BACKGROUND_TASK_ELECTION", "1");
    const posts = installLoopbackCallbackFetch();
    const runtime = createTestRuntime({ agent: { name: "task-notify-complete" } });
    const continuationToken = "http:task-notify-complete";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Delegate to a background subagent: research penguins" },
          serializedContext: buildSerializedContext({ continuationToken }),
        },
      ]);
      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "election turn",
          (event) => event.type === "session.waiting",
        );

        // The call position was terminalized with the placeholder: the
        // turn ended with the work "still running" and no child events.
        const taskId = extractTaskId(firstTurn);
        expect(taskId).toMatch(/^task_/);
        expect(filterEventsByType(firstTurn, "subagent.called")).toHaveLength(0);
        expect(filterEventsByType(firstTurn, "subagent.completed")).toHaveLength(0);
        expect(posts).toHaveLength(0);

        await waitForHook({ runId: run.runId }, { token: continuationToken });

        // The test acts as the executor: terminal transition → notify.
        await sendTaskCommand(taskId, {
          command: { kind: "complete", result: { answer: 42 } },
          commandId: "cmd-complete-1",
          kind: "task-command",
        });

        const wakeTurn = await stream.nextUntil(
          "terminal wake turn",
          (event) => event.type === "session.waiting",
        );

        // The parked driver woke on the loopback POST and ran a turn
        // with the outcome as new input.
        expect(posts).toHaveLength(1);
        expect(posts[0]).toMatchObject({ body: { kind: "task.terminal" }, status: 202 });
        expect(
          wakeTurn.some(
            (event) =>
              event.type === "message.completed" && event.data.message?.includes(taskId) === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);

  it("re-emits input_required without a turn and routes the late answer via updateTask", async () => {
    vi.stubEnv("EVE_INTERNAL_BACKGROUND_TASK_ELECTION", "1");
    const posts = installLoopbackCallbackFetch();
    const runtime = createTestRuntime({ agent: { name: "task-notify-input" } });
    const continuationToken = "http:task-notify-input";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Delegate to a background subagent: research volcanoes" },
          serializedContext: buildSerializedContext({ continuationToken }),
        },
      ]);
      const stream = captureEvents(run);

      try {
        const firstTurn = await stream.nextUntil(
          "election turn",
          (event) => event.type === "session.waiting",
        );
        const taskId = extractTaskId(firstTurn);
        await waitForHook({ runId: run.runId }, { token: continuationToken });

        // Executor needs input: input_required is consumed by the
        // routing step — input.requested re-emitted, no model turn.
        await sendTaskCommand(taskId, {
          command: { inputRequests: [taskInputRequest], kind: "require-input" },
          commandId: "cmd-require-1",
          kind: "task-command",
        });

        const untilRequested = await stream.nextUntil(
          "re-emitted input.requested",
          (event) => event.type === "input.requested",
        );
        expect(filterEventsByType(untilRequested, "turn.started")).toHaveLength(0);
        const requested = untilRequested.at(-1);
        if (requested?.type !== "input.requested") {
          throw new Error("Expected the stream to end on input.requested.");
        }
        expect(requested.data).toMatchObject({
          requests: [{ prompt: taskInputRequest.prompt, requestId: taskInputRequest.requestId }],
        });

        // The user answers in the parent conversation. Step-0 routes
        // the response to updateTask — the model never sees it, so no
        // reply turn runs (a stale-converted response would produce
        // one). The task transitions back to working, whose wake is
        // consumed silently; the later terminal wake is the next turn.
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [
            { inputResponses: [{ optionId: "approve", requestId: taskInputRequest.requestId }] },
          ],
        });

        // The update's task.status notification is the observable proof
        // the answer routed through updateTask; wait for it before the
        // executor completes, or the completion races the answer turn.
        await waitForPosts(posts, 2);
        expect(posts[1]).toMatchObject({ body: { kind: "task.status" }, status: 202 });

        await sendTaskCommand(taskId, {
          command: { kind: "complete", result: "research complete" },
          commandId: "cmd-complete-2",
          kind: "task-command",
        });

        const wakeTurn = await stream.nextUntil(
          "terminal wake turn",
          (event) => event.type === "session.waiting",
        );

        // Exactly one model turn between the answer and the terminal
        // wake — the answer itself never woke the model.
        expect(filterEventsByType(wakeTurn, "turn.started")).toHaveLength(1);
        expect(
          wakeTurn.some(
            (event) =>
              event.type === "message.completed" && event.data.message?.includes(taskId) === true,
          ),
        ).toBe(true);

        // require-input and the update both notify task.status; the
        // completion notifies task.terminal.
        expect(posts.map((post) => post.body.kind)).toEqual([
          "task.status",
          "task.status",
          "task.terminal",
        ]);
        expect(posts.every((post) => post.status === 202)).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);
});
