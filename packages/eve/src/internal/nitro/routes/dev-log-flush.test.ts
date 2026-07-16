import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
} from "#internal/workflow/development-world-protocol.js";

const clientMocks = vi.hoisted(() => ({
  flushDevelopmentLogs: vi.fn(async () => undefined),
}));

vi.mock("#internal/dev-logs/client.js", () => clientMocks);

const { handleDevLogFlushRequest } = await import("#internal/nitro/routes/dev-log-flush.js");

afterEach(() => {
  clientMocks.flushDevelopmentLogs.mockClear();
  vi.unstubAllEnvs();
});

describe("development log flush route", () => {
  it("flushes only authenticated worker requests", async () => {
    vi.stubEnv(DEVELOPMENT_WORKFLOW_SECRET_ENV, "development-secret");

    const rejected = await handleDevLogFlushRequest(
      new Request("http://localhost/eve/v1/dev/internal/log/flush", { method: "POST" }),
    );
    const accepted = await handleDevLogFlushRequest(
      new Request("http://localhost/eve/v1/dev/internal/log/flush", {
        headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: "development-secret" },
        method: "POST",
      }),
    );

    expect(rejected.status).toBe(401);
    expect(accepted.status).toBe(204);
    expect(clientMocks.flushDevelopmentLogs).toHaveBeenCalledOnce();
  });
});
