import { describe, expect, it, vi } from "vitest";

import { handleDevelopmentLogRequest } from "#internal/dev-logs/handler.js";
import { DEVELOPMENT_LOG_ROUTE } from "#internal/dev-logs/protocol.js";
import { encodeDevelopmentWorldValue } from "#internal/workflow/development-world-codec.js";
import { DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER } from "#internal/workflow/development-world-protocol.js";

const SECRET = "development-log-transport-secret";

describe("development log ingest handler", () => {
  it("accepts authenticated worker output independently of a Workflow World", async () => {
    const appendOutputEvents = vi.fn(async () => undefined);
    const event = {
      at: "2026-07-16T18:00:00.000Z",
      process: "worker" as const,
      stream: "stderr" as const,
      text: "worker startup failed\n",
      type: "process.output" as const,
    };

    const response = await handleDevelopmentLogRequest({
      log: { appendOutputEvents },
      request: request({ events: [event] }, SECRET),
      transportSecret: SECRET,
    });

    expect(response?.status).toBe(204);
    expect(appendOutputEvents).toHaveBeenCalledWith([event]);
  });

  it("rejects untrusted and malformed input at the app boundary", async () => {
    const log = { appendOutputEvents: vi.fn(async () => undefined) };
    const untrusted = await handleDevelopmentLogRequest({
      log,
      request: request({ events: [] }, "forged"),
      transportSecret: SECRET,
    });
    const malformed = await handleDevelopmentLogRequest({
      log,
      request: request({ events: [] }, SECRET),
      transportSecret: SECRET,
    });

    expect(untrusted?.status).toBe(401);
    expect(malformed?.status).toBe(400);
  });
});

function request(body: unknown, secret: string): Request {
  return new Request(`http://localhost${DEVELOPMENT_LOG_ROUTE}`, {
    body: encodeDevelopmentWorldValue(body),
    headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: secret },
    method: "POST",
  });
}
