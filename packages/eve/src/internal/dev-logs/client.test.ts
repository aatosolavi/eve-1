import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeDevelopmentWorldValue } from "#internal/workflow/development-world-codec.js";
import { DEVELOPMENT_WORKFLOW_SECRET_ENV } from "#internal/workflow/development-world-protocol.js";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.WORKFLOW_LOCAL_BASE_URL;
const originalSecret = process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnvironment("WORKFLOW_LOCAL_BASE_URL", originalBaseUrl);
  restoreEnvironment(DEVELOPMENT_WORKFLOW_SECRET_ENV, originalSecret);
  vi.resetModules();
});

describe("development log client", () => {
  it("flushes adjacent output events in one ordered request", async () => {
    process.env.WORKFLOW_LOCAL_BASE_URL = "http://eve-dev.local";
    process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV] = "development-secret";
    const requests: Request[] = [];
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 204 });
    });
    const { flushDevelopmentLogs, writeDevelopmentLog } =
      await import("#internal/dev-logs/client.js");
    const first = {
      at: "2026-07-16T18:00:00.000Z",
      process: "worker" as const,
      stream: "stdout" as const,
      text: "hello",
      type: "process.output" as const,
    };
    const second = {
      at: "2026-07-16T18:00:00.001Z",
      process: "worker" as const,
      sessionId: "wrun_session",
      stream: "stderr" as const,
      text: "failure",
      type: "process.output" as const,
    };

    void writeDevelopmentLog(first);
    void writeDevelopmentLog(second);
    await flushDevelopmentLogs();

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request === undefined) throw new Error("Expected a batched development log request.");
    expect(decodeDevelopmentWorldValue(await request.text())).toEqual({
      events: [first, second],
    });
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
