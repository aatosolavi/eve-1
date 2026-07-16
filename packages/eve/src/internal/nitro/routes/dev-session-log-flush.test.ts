import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
} from "#internal/workflow/development-world-protocol.js";

const clientMocks = vi.hoisted(() => ({
  flushDevelopmentSessionLogs: vi.fn(async () => undefined),
}));

vi.mock("#internal/session-logs/client.js", () => clientMocks);

const { handleDevSessionLogFlushRequest } =
  await import("#internal/nitro/routes/dev-session-log-flush.js");

afterEach(() => {
  clientMocks.flushDevelopmentSessionLogs.mockClear();
  vi.unstubAllEnvs();
});

describe("development session log flush route", () => {
  it("flushes only authenticated worker requests", async () => {
    vi.stubEnv(DEVELOPMENT_WORKFLOW_SECRET_ENV, "development-secret");

    const rejected = await handleDevSessionLogFlushRequest(
      new Request("http://localhost/eve/v1/dev/internal/session-log/flush", { method: "POST" }),
    );
    const accepted = await handleDevSessionLogFlushRequest(
      new Request("http://localhost/eve/v1/dev/internal/session-log/flush", {
        headers: { [DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER]: "development-secret" },
        method: "POST",
      }),
    );

    expect(rejected.status).toBe(401);
    expect(accepted.status).toBe(204);
    expect(clientMocks.flushDevelopmentSessionLogs).toHaveBeenCalledOnce();
  });
});
