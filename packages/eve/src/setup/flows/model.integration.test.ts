import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectModelProviderStatus } from "./model.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("detectModelProviderStatus", () => {
  it("recognizes an inherited AI Gateway key without requiring an env-file copy", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-model-provider-env-"));
    vi.stubEnv("AI_GATEWAY_API_KEY", "gateway-key-from-shell");

    await expect(detectModelProviderStatus(appRoot)).resolves.toEqual({
      kind: "gateway-key",
      envKey: "AI_GATEWAY_API_KEY",
      envFile: "the shell environment",
    });
  });
});
