import { describe, expect, test, vi } from "vitest";

import type { ChannelSetupLog } from "./cli/index.js";
import {
  encodePhotonConnectCredential,
  parseCreatedPhotonConnector,
  PHOTON_TRIGGER_PATH,
  provisionPhotonConnector,
} from "./photon-connect.js";

function log(): ChannelSetupLog {
  return {
    message: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    commandOutput: vi.fn(),
  };
}

describe("Photon Connect provisioning", () => {
  test("encodes separately collected credentials for Photon Basic auth", () => {
    expect(
      encodePhotonConnectCredential({ projectId: " project-id ", projectSecret: " secret:value " }),
    ).toBe("project-id:secret:value");
  });

  test("rejects an ambiguous project id", () => {
    expect(() =>
      encodePhotonConnectCredential({ projectId: "bad:id", projectSecret: "secret" }),
    ).toThrow("Photon project ID cannot contain a colon.");
  });

  test("parses an app-scoped connector", () => {
    expect(
      parseCreatedPhotonConnector(
        JSON.stringify({
          id: "scl_photon",
          uid: "spectrum.photon.codes/imessage0",
          supportedSubjectTypes: ["app"],
        }),
      ),
    ).toEqual({ id: "scl_photon", uid: "spectrum.photon.codes/imessage0" });
  });

  test("creates with stdin credentials and attaches the eve webhook", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true as const,
      stdout: JSON.stringify({
        id: "scl_photon",
        uid: "spectrum.photon.codes/imessage0",
        supportedSubjectTypes: ["app"],
      }),
    }));
    const runVercel = vi.fn(async () => true);

    await expect(
      provisionPhotonConnector({
        credentials: { projectId: "project-id", projectSecret: "project-secret" },
        log: log(),
        project: { orgId: "team_123", projectId: "prj_123" },
        projectRoot: "/tmp/imessage0",
        slug: "imessage0",
        deps: { runVercel, runVercelCaptureStdout },
      }),
    ).resolves.toEqual({ id: "scl_photon", uid: "spectrum.photon.codes/imessage0" });

    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "connect",
        "create",
        "spectrum.photon.codes",
        "--connector-type",
        "api-key",
        "--data",
        "@-",
        "--name",
        "imessage0",
        "--triggers",
        "-F",
        "json",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({
        cwd: "/tmp/imessage0",
        nonInteractive: true,
        stdin: JSON.stringify({ values: [{ value: "project-id:project-secret" }] }),
      }),
    );
    expect(runVercel).toHaveBeenCalledWith(
      [
        "connect",
        "attach",
        "spectrum.photon.codes/imessage0",
        "--project",
        "prj_123",
        "--environment",
        "production",
        "--triggers",
        "--trigger-path",
        PHOTON_TRIGGER_PATH,
        "--yes",
        "--scope",
        "team_123",
      ],
      expect.objectContaining({ cwd: "/tmp/imessage0", nonInteractive: true }),
    );
  });
});
