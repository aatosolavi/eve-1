import { describe, expect, test, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { interactiveAsker } from "../ask.js";
import { runInteractive } from "../runner.js";
import { createDefaultSetupState, snapshotSetupState } from "../state.js";
import { configurePhotonWebhook } from "./configure-photon-webhook.js";

const sink = { write: () => {} };

describe("configurePhotonWebhook", () => {
  test("shows the Connect trigger and saves the Photon secret", async () => {
    const fake = createFakePrompter({ password: () => "whsec_test" });
    const runVercel = vi.fn(async () => true);
    const box = configurePhotonWebhook({
      asker: interactiveAsker(fake.prompter),
      prompter: fake.prompter,
      deps: {
        readProjectLink: vi.fn(async () => ({ orgId: "team_123", projectId: "prj_123" })),
        runVercel,
      },
    });
    const state = {
      ...createDefaultSetupState(),
      channels: ["imessage" as const],
      photonConnectorId: "scl_photon",
      projectPath: { kind: "resolved" as const, inPlace: true, path: "/tmp/agent" },
    };

    const result = await runInteractive([box], state, sink, { snapshot: snapshotSetupState });

    expect(result.kind).toBe("done");
    expect(fake.prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("https://connect.vercel.com/trigger/scl_photon"),
      "Photon webhook",
    );
    expect(runVercel).toHaveBeenCalledWith(
      ["env", "add", "IMESSAGE_WEBHOOK_SECRET", "production", "--force", "--scope", "team_123"],
      expect.objectContaining({
        cwd: "/tmp/agent",
        nonInteractive: true,
        stdin: "whsec_test",
      }),
    );
    if (result.kind === "done") expect(result.state.photonWebhookConfigured).toBe(true);
  });
});
