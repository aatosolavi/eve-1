import { text, type Asker } from "../ask.js";
import { createPromptCommandOutput } from "../cli/index.js";
import type { Prompter } from "../prompter.js";
import { runVercel } from "../primitives/run-vercel.js";
import { requireProjectPath, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";
import { readProjectLink } from "../project-resolution.js";

/** Dependencies for persisting the Photon webhook secret. */
export interface ConfigurePhotonWebhookDeps {
  readProjectLink: typeof readProjectLink;
  runVercel: typeof runVercel;
}

/**
 * Completes Photon setup after Connect has created the connector, when its
 * stable trigger URL is available to register in the Photon dashboard.
 */
export function configurePhotonWebhook(options: {
  asker: Asker;
  prompter: Prompter;
  deps?: Partial<ConfigurePhotonWebhookDeps>;
}): SetupBox<SetupState, string | null, boolean> {
  const deps: ConfigurePhotonWebhookDeps = {
    readProjectLink,
    runVercel,
    ...options.deps,
  };

  return {
    id: "configure-photon-webhook",

    async gather({ state }) {
      if (!state.channels.includes("imessage") || state.photonWebhookConfigured) return null;
      if (state.photonConnectorId === undefined) {
        throw new Error("Photon connector ID is missing; webhook setup cannot continue.");
      }
      options.prompter.note(
        `Create a Photon webhook with this URL:\n\nhttps://connect.vercel.com/trigger/${state.photonConnectorId}\n\nThen copy the signing secret Photon shows.`,
        "Photon webhook",
      );
      return options.asker.ask(
        text({
          key: "photon-webhook-secret",
          message: "Photon webhook signing secret",
          required: true,
          sensitive: true,
          validate: (value) => (value.trim() ? null : "Webhook signing secret is required"),
        }),
      );
    },

    async perform({ state, input, signal }) {
      if (input === null) return state.photonWebhookConfigured;
      const projectRoot = requireProjectPath(state);
      const project = await deps.readProjectLink(projectRoot);
      if (project === undefined) throw new Error("Expected a linked Vercel project for Photon.");
      const saved = await deps.runVercel(
        [
          "env",
          "add",
          "IMESSAGE_WEBHOOK_SECRET",
          "production",
          "--force",
          "--scope",
          project.orgId,
        ],
        {
          cwd: projectRoot,
          nonInteractive: true,
          onOutput: createPromptCommandOutput(options.prompter.log),
          signal,
          stdin: input,
        },
      );
      if (!saved) throw new Error("Could not save the Photon webhook signing secret to Vercel.");
      return true;
    },

    apply(state, configured) {
      return configured ? { ...state, photonWebhookConfigured: true } : state;
    },
  };
}
