import { Client } from "#client/index.js";
import type { DeferredBootProgress } from "#internal/dev-boot-progress.js";
import {
  resolveLocalDevelopmentClientOptions,
  resolveRemoteDevelopmentClientOptions,
} from "#services/dev-client/client-options.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import {
  resolveDevelopmentOidcToken,
  resolveLinkedDevelopmentOidcToken,
} from "#services/dev-client/request-headers.js";
import { isVercelAuthChallenge } from "#services/dev-client/vercel-auth-error.js";
import { resolveVercelDeployment } from "#setup/vercel-deployment.js";
import { toErrorMessage } from "#shared/errors.js";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import { promptCommandsFor } from "./prompt-commands.js";
import { formatRemoteAuthChallengeMessage } from "./remote-auth-result.js";
import { probeMcpConnection } from "./mcp-connection-status.js";
import { EveTUIRunner, type EveTUIRunnerOptions } from "./runner.js";
import { startupStatusForBootPhase } from "./startup-status.js";
import { remoteHost, type DevelopmentTuiTarget, type RemoteDevelopmentTarget } from "./target.js";
import { TerminalRenderer } from "./terminal-renderer.js";
import type { TuiDisplayOptions } from "./types.js";

/** The local server URL and app root resolved by a deferred `eve dev` boot. */
export interface BootedLocalServer {
  readonly serverUrl: string;
  readonly appRoot: string;
}

export type { DevelopmentTuiTarget } from "./target.js";

export interface RunDevelopmentTuiInput extends TuiDisplayOptions {
  /** The local server or remote URL used by this TUI session. */
  readonly target: DevelopmentTuiTarget;
  /** Additional request headers sent by this TUI client. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Text to seed the prompt input with after the UI launches. A bare local
   * `/model` starts fresh-agent onboarding. Applies to the first prompt only.
   */
  readonly initialInput?: string;
  /**
   * Boots the local `eve dev` server after the shell has painted. When present,
   * the shell renders first and this resolves the server URL; the boot phases it
   * drives are shown inside the shell via {@link onBootProgress}. Omitted for
   * remote sessions and when attaching to an already-running local server.
   */
  readonly bootServer?: () => Promise<BootedLocalServer>;
  /**
   * Local CLI boot-phase progress. The shell attaches its observer once painted
   * so phases render inside it. Omitted for remote and programmatic TUI runs.
   */
  readonly onBootProgress?: DeferredBootProgress;
}

function prepareRemoteTarget(target: RemoteDevelopmentTarget) {
  const credentials = createDevelopmentCredentialGate(target.serverUrl);
  return {
    target,
    credentials,
    resolveOidcToken: resolveDevelopmentOidcToken,
    resolveDeployment: (signal: AbortSignal) =>
      resolveVercelDeployment({
        workspaceRoot: target.workspaceRoot,
        host: remoteHost(target),
        signal,
      }),
  } satisfies NonNullable<EveTUIRunnerOptions["remote"]>;
}

type PreparedDevelopmentTuiTarget =
  | {
      readonly kind: "local";
      readonly target: Extract<DevelopmentTuiTarget, { kind: "local" }>;
    }
  | {
      readonly kind: "remote";
      readonly target: RemoteDevelopmentTarget;
      readonly remote: NonNullable<EveTUIRunnerOptions["remote"]>;
    };

function prepareDevelopmentTarget(target: DevelopmentTuiTarget): PreparedDevelopmentTuiTarget {
  return target.kind === "local"
    ? { kind: "local", target }
    : { kind: "remote", target, remote: prepareRemoteTarget(target) };
}

/**
 * Runs the `eve dev` terminal UI against the given server URL until the
 * user exits.
 *
 * The configured client is handed to the runner so its subagent
 * child-session streams inherit the same auth. Turn-dispatch failures —
 * including the Vercel Deployment Protection challenge — are formatted into
 * the inline error region rather than crashing the command.
 */
export async function runDevelopmentTui(input: RunDevelopmentTuiInput): Promise<void> {
  const { target, headers, initialInput, onBootProgress, bootServer, ...display } = input;
  const prepared = prepareDevelopmentTarget(target);
  const headerOptions = headers === undefined ? {} : { headers };

  // The renderer needs no client, so it is built and painted before the server
  // boots. Boot phases stream into its startup region instead of the console.
  const renderer = new TerminalRenderer({
    tools: display.tools,
    reasoning: display.reasoning,
    subagents: display.subagents,
    connectionAuth: display.connectionAuth,
    assistantResponseStats: display.assistantResponseStats,
    contextSize: display.contextSize,
    logs: display.logs,
    availablePromptCommands: promptCommandsFor(target.kind),
  });

  let serverUrl = target.serverUrl;
  // Local sessions track the workspace root for OIDC/link resolution. A
  // deferred boot yields the host's canonical root; otherwise fall back to the
  // target's known workspace root.
  let localAppRoot = prepared.kind === "local" ? prepared.target.workspaceRoot : undefined;
  if (bootServer !== undefined) {
    renderer.setStartupStatus({ kind: "working", label: "Building your agent" });
    onBootProgress?.observe((event) => {
      if (event.type === "phase-started") {
        renderer.setStartupStatus(startupStatusForBootPhase(event.phase));
      }
    });
    try {
      const booted = await bootServer();
      serverUrl = booted.serverUrl;
      localAppRoot = booted.appRoot;
    } catch (error) {
      renderer.setStartupStatus({
        kind: "failed",
        label: "The dev server failed to start.",
        detail: toErrorMessage(error),
      });
      onBootProgress?.observe(undefined);
      renderer.shutdown();
      throw error;
    }
  }

  if (serverUrl === undefined) {
    throw new Error("runDevelopmentTui requires a booted server URL or a bootServer.");
  }
  const resolvedServerUrl = serverUrl;

  const client = new Client(
    prepared.kind === "local"
      ? resolveLocalDevelopmentClientOptions({
          ...headerOptions,
          serverUrl: resolvedServerUrl,
          token: () =>
            resolveLinkedDevelopmentOidcToken(localAppRoot ?? prepared.target.workspaceRoot),
        })
      : resolveRemoteDevelopmentClientOptions({
          ...headerOptions,
          serverUrl: resolvedServerUrl,
          credentials: prepared.remote.credentials,
        }),
  );

  const options: EveTUIRunnerOptions = {
    ...display,
    renderer,
    session: client.session(),
    client,
    serverUrl: resolvedServerUrl,
    promptCommandHandler: createPromptCommandHandler({ target }),
    availablePromptCommands: promptCommandsFor(target.kind),
    formatTransportError: (error) =>
      isVercelAuthChallenge(error)
        ? formatRemoteAuthChallengeMessage(resolvedServerUrl)
        : toErrorMessage(error),
  };
  if (prepared.kind === "local") {
    options.appRoot = localAppRoot ?? prepared.target.workspaceRoot;
    options.probeMcpConnection = probeMcpConnection;
  } else {
    options.remote = prepared.remote;
  }
  if (initialInput !== undefined) options.initialInput = initialInput;
  if (onBootProgress !== undefined) options.onBootProgress = onBootProgress.reporter;

  await new EveTUIRunner(options).run();
}
