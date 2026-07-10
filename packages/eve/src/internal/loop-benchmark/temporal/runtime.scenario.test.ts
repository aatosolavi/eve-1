import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { RunInput } from "#channel/types.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockTool } from "#internal/testing/mocks/mock-tool.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createLocalTemporalBenchmarkRuntime } from "./runtime.js";

const ADAPTER: ChannelAdapter = { kind: "http" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("LocalTemporalBenchmarkRuntime", () => {
  it("runs the production one-tool loop through a child Workflow and rekeys after it completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-temporal-loop-benchmark-"));
    vi.stubEnv("EVE_LOOP_BENCHMARK_RECORD_PATH", join(directory, "records.jsonl"));
    let toolExecutions = 0;
    const tool = mockTool({
      description: "Echo the benchmark nonce for runtime overhead measurement.",
      execute(rawInput) {
        toolExecutions += 1;
        const nonce = readNonce(rawInput);
        return `benchmark-verified:${nonce}`;
      },
      inputSchema: {
        additionalProperties: false,
        properties: { nonce: { type: "string" } },
        required: ["nonce"],
        type: "object",
      },
      name: "benchmark_echo",
    });
    const app = createTestRuntime({
      agent: { name: "temporal-loop-benchmark" },
      tools: [tool],
    });
    const manifestTool = app.manifest.tools.find((candidate) => candidate.name === tool.name);
    if (manifestTool === undefined) throw new Error("benchmark_echo is missing from the manifest.");
    app.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
      default: { execute: tool.execute },
    };

    await app.run(async () => {
      const runtime = await createLocalTemporalBenchmarkRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      try {
        const handle = await runtime.run(createRunInput());
        const events = await readThroughWaiting(handle.events);

        expect(events.at(-1)?.type).toBe("session.waiting");
        expect(events.filter((event) => event.type === "step.completed")).toHaveLength(2);
        const requests = events.filter((event) => event.type === "actions.requested");
        expect(requests).toHaveLength(1);
        expect(requests[0]?.data.actions).toEqual([
          {
            callId: "call_benchmark_echo",
            input: { nonce: "nonce-123" },
            kind: "tool-call",
            toolName: "benchmark_echo",
          },
        ]);
        const messages = events.filter((event) => event.type === "message.appended");
        expect(messages).toHaveLength(1);
        expect(messages[0]?.data.messageSoFar).toBe(
          'Used benchmark_echo for "Use benchmark_echo exactly once with nonce "nonce-123".": benchmark-verified:nonce-123',
        );
        expect(toolExecutions).toBe(1);

        const history = await waitForRekeyHistory(runtime, handle.sessionId);
        expect(history.childWorkflowsStarted).toBe(1);
        expect(history.rekeyScheduledAfterChildCompletion).toBe(true);
        expect(history.scheduledActivityTypes).toEqual(
          expect.arrayContaining(["createSession", "rekeySession"]),
        );

        const records = await waitForParkRecords(runtime, "temporal-scenario-sample");
        const intervalNames = records.flatMap((record) =>
          record.kind === "interval" ? [record.name] : [],
        );
        expect(intervalNames).toEqual(
          expect.arrayContaining([
            "engine.dispatch",
            "session.create.operation",
            "turn.step.operation",
            "event.publish",
            "session.rekey",
          ]),
        );
        expect(
          records.some(
            (record) => record.kind === "mark" && record.name === "runtime.park.accepted",
          ),
        ).toBe(true);
        expect(records.every((record) => record.runtime === "temporal")).toBe(true);
        expect(intervalNames).not.toContain("session.settle");
      } finally {
        await runtime.close();
      }
    });
  });
});

function createRunInput(): RunInput {
  return {
    adapter: ADAPTER,
    auth: null,
    capabilities: { requestInput: true },
    continuationToken: "http:temporal-benchmark",
    input: {
      message: 'Use benchmark_echo exactly once with nonce "nonce-123".',
    },
    mode: "conversation",
    requestId: "temporal-scenario-sample",
  };
}

function readNonce(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("nonce" in value) ||
    typeof value.nonce !== "string"
  ) {
    throw new TypeError("benchmark_echo requires a string nonce.");
  }
  return value.nonce;
}

async function readThroughWaiting(
  stream: ReadableStream<HandleMessageStreamEvent>,
): Promise<readonly HandleMessageStreamEvent[]> {
  const reader = stream.getReader();
  const events: HandleMessageStreamEvent[] = [];
  try {
    while (true) {
      const next = await withTimeout(reader.read(), "Temporal benchmark event stream");
      if (next.done) throw new Error("Temporal benchmark stream closed before session.waiting.");
      events.push(next.value);
      if (next.value.type === "session.waiting") return events;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function waitForRekeyHistory(
  runtime: Awaited<ReturnType<typeof createLocalTemporalBenchmarkRuntime>>,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof runtime.inspectHistory>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const history = await runtime.inspectHistory(sessionId);
    if (history.rekeyScheduledAfterChildCompletion) return history;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Temporal history did not record rekey after child completion.");
}

async function waitForParkRecords(
  runtime: Awaited<ReturnType<typeof createLocalTemporalBenchmarkRuntime>>,
  sampleId: string,
): Promise<Awaited<ReturnType<typeof runtime.records>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const records = await runtime.records(sampleId);
    if (
      records.some((record) => record.kind === "mark" && record.name === "runtime.park.accepted")
    ) {
      return records;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Temporal benchmark did not record accepted park telemetry.");
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out.`)), 30_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
