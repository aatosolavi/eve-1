import { describe, expect, it, vi } from "vitest";

import type { VerifiedVercelTarget } from "#setup/vercel-deployment.js";

import { prepareVercelCredential } from "./vercel-credential.js";

const target = {
  deployment: {
    environment: "preview",
    ownerId: "team_1",
    projectId: "project_1",
    projectName: "agent",
    provider: "vercel",
  },
} as VerifiedVercelTarget;

describe("prepareVercelCredential", () => {
  it("forces the initial token and keeps the last valid token across refresh failures", async () => {
    const resolveToken = vi
      .fn()
      .mockResolvedValueOnce({ kind: "resolved", token: " initial " })
      .mockResolvedValueOnce({ kind: "failed", message: "offline" });

    const prepared = await prepareVercelCredential(target, resolveToken);

    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") return;
    await expect(prepared.resolveToken()).resolves.toBe("initial");
    expect(resolveToken).toHaveBeenNthCalledWith(1, {
      forceRefresh: true,
      ownerId: "team_1",
      projectId: "project_1",
    });
    expect(resolveToken).toHaveBeenNthCalledWith(2, target.deployment);
  });
});
