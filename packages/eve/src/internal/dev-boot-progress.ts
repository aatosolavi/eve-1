export type DevBootProgressEvent =
  | {
      readonly phase: string;
      readonly type: "phase-started";
    }
  | {
      readonly elapsedMs: number;
      readonly phase: string;
      readonly type: "phase-finished";
    }
  | {
      readonly type: "before-first-paint";
    };

export type DevBootProgressReporter = (event: DevBootProgressEvent) => void;

/**
 * A boot-progress reporter whose downstream observer can be attached after the
 * reporter is already wired into the host. `eve dev` builds the server (which
 * captures {@link reporter} in its options) before the TUI shell exists, then
 * calls {@link observe} once the shell is ready so boot phases render inside it.
 */
export interface DeferredBootProgress {
  /** The stable reporter handed to the host at construction. */
  readonly reporter: DevBootProgressReporter;
  /** Routes subsequent events to `sink`, or stops routing when `undefined`. */
  observe(sink: DevBootProgressReporter | undefined): void;
}

/** Creates a {@link DeferredBootProgress} whose sink starts detached. */
export function createDeferredBootProgress(): DeferredBootProgress {
  let sink: DevBootProgressReporter | undefined;
  return {
    reporter: (event) => sink?.(event),
    observe: (next) => {
      sink = next;
    },
  };
}

/** Runs one measured boot phase and reports it to this invocation's observer. */
export async function devBootPhase<T>(
  phase: string,
  run: () => Promise<T>,
  report?: DevBootProgressReporter,
): Promise<T> {
  if (report === undefined) return await run();

  const startedAt = Date.now();
  report({ phase, type: "phase-started" });
  try {
    return await run();
  } finally {
    report({ elapsedMs: Date.now() - startedAt, phase, type: "phase-finished" });
  }
}
