import { afterEach, describe, expect, it, vi } from "vitest";

import { contextStorage, ContextContainer } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { EXPAND_TOOL_RESULT_TOOL_DEFINITION } from "#runtime/framework-tools/expand-tool-result.js";

const getReadableMock = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: vi.fn(() => ({ getReadable: getReadableMock })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function streamOfEvents(lines: readonly string[]): {
  getReader(): ReadableStreamDefaultReader<string>;
  getTailIndex(): Promise<number>;
} {
  const readable = new ReadableStream<string>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(`${line}\n`);
      }
      // Deliberately never closed: the durable stream tails while the
      // session is live, and the reader must stop at the tail index.
    },
  });
  return Object.assign(readable, { getTailIndex: () => Promise.resolve(lines.length) }) as never;
}

function actionResultLine(callId: string, output: unknown): string {
  return JSON.stringify({
    data: { result: { callId, kind: "tool-result", output, toolName: "grep" } },
    type: "action.result",
  });
}

async function execute(input: unknown, sessionRunId?: string): Promise<unknown> {
  const ctx = new ContextContainer();
  if (sessionRunId !== undefined) {
    ctx.set(SessionIdKey, sessionRunId);
  }
  const exec = EXPAND_TOOL_RESULT_TOOL_DEFINITION.execute;
  if (exec === undefined) {
    throw new Error("expand_tool_result must define execute.");
  }
  return contextStorage.run(ctx, () => exec(input, {} as Parameters<NonNullable<typeof exec>>[1]));
}

describe("expand_tool_result", () => {
  it("returns a page of the recorded output with continuation info", async () => {
    const payload = { content: "m".repeat(10_000) };
    getReadableMock.mockReturnValue(
      streamOfEvents([
        JSON.stringify({ data: {}, type: "turn.started" }),
        actionResultLine("call-1", payload),
      ]),
    );

    const result = (await execute(
      { limitChars: 100, toolCallId: "call-1" },
      "wrun_session",
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.toolName).toBe("grep");
    expect(result.totalChars).toBe(JSON.stringify(payload).length);
    expect(String(result.content)).toHaveLength(100);
    expect(result.moreAfter).toBe(true);
  });

  it("continues from offsetChars where a page ended", async () => {
    const payload = "abcdefghij";
    getReadableMock.mockReturnValue(streamOfEvents([actionResultLine("call-1", payload)]));

    const result = (await execute(
      { limitChars: 4, offsetChars: 4, toolCallId: "call-1" },
      "wrun_session",
    )) as Record<string, unknown>;

    // Serialized form is the quoted JSON string.
    expect(result.content).toBe(JSON.stringify(payload).slice(4, 8));
    expect(result.moreAfter).toBe(true);
  });

  it("returns a structured miss for an unknown call id", async () => {
    getReadableMock.mockReturnValue(streamOfEvents([actionResultLine("call-1", "x")]));

    const result = (await execute({ toolCallId: "call-missing" }, "wrun_session")) as Record<
      string,
      unknown
    >;

    expect(result.found).toBe(false);
    expect(String(result.reason)).toContain("call-missing");
  });

  it("returns a structured miss when the session has no stream", async () => {
    const result = (await execute({ toolCallId: "call-1" })) as Record<string, unknown>;

    expect(result.found).toBe(false);
    expect(getReadableMock).not.toHaveBeenCalled();
  });
});
