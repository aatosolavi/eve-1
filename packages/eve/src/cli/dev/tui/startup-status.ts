/**
 * Startup progress surfaced inside the dev TUI shell. The shell paints before
 * the local server finishes booting; while deferrable startup work runs it
 * shows one of these snapshots instead of the prompt, so build, connection, and
 * active-run recovery report their progress in the shell rather than as console
 * preamble.
 */
export type StartupStatusSnapshot =
  | {
      /** A startup task is in flight; the shell shows a spinner and this label. */
      readonly kind: "working";
      readonly label: string;
      /** Optional secondary line, e.g. the active boot phase or a recovery count. */
      readonly detail?: string;
    }
  | {
      /** All deferrable startup work finished; the shell activates its controls. */
      readonly kind: "ready";
    }
  | {
      /** Startup failed; the shell shows the failure with recovery context. */
      readonly kind: "failed";
      readonly label: string;
      /** What went wrong and, where possible, how to recover or retry. */
      readonly detail?: string;
    };

/**
 * Maps a measured boot phase name (see {@link devBootPhase}) to the label shown
 * in the startup shell. Build phases collapse under one "Building your agent"
 * headline with the phase as detail; connection has its own headline.
 */
export function startupStatusForBootPhase(phase: string): StartupStatusSnapshot {
  if (phase === "connecting to agent") {
    return { kind: "working", label: "Connecting to agent" };
  }
  if (phase === "recovering active runs") {
    return { kind: "working", label: "Recovering active runs" };
  }
  return { kind: "working", label: "Building your agent", detail: phase };
}
