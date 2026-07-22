import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { watch } from "#compiled/chokidar/index.js";
import { createLogger, formatError } from "#internal/logging.js";

const log = createLogger("tracing.watcher");

/** Notified with the affected run id whenever that run's trace changes on disk. */
export type TraceChangeListener = (runId: string) => void;

/** A shared, subscribable watcher over one app's `.eve/traces` directory. */
export interface TraceWatcher {
  subscribe(listener: TraceChangeListener): () => void;
  close(): Promise<void>;
}

// One watcher per app root, shared across all SSE connections in this dev
// process. Trace capture happens in worker processes and lands on disk, so the
// parent (which serves the viewer) learns of new spans by watching the files.
const watchers = new Map<string, TraceWatcher>();

/** Returns the shared {@link TraceWatcher} for an app root, creating it once. */
export function getTraceWatcher(appRoot: string): TraceWatcher {
  const existing = watchers.get(appRoot);
  if (existing !== undefined) return existing;
  const created = createTraceWatcher(appRoot);
  watchers.set(appRoot, created);
  return created;
}

function createTraceWatcher(appRoot: string): TraceWatcher {
  const directory = join(appRoot, ".eve", "traces");
  // Ensure the directory exists so chokidar has something to watch before the
  // first capture creates it.
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    log.debug("could not pre-create traces directory", { error: formatError(error) });
  }

  const listeners = new Set<TraceChangeListener>();
  const watcher = watch(directory, {
    ignoreInitial: true,
    awaitWriteFinish: { pollInterval: 30, stabilityThreshold: 80 },
  });

  watcher.on("all", (_event: string, changedPath: string) => {
    if (!changedPath.endsWith(".otlp.json")) return;
    // Layout is `.eve/traces/<runId>/<segment>.otlp.json`.
    const runId = basename(dirname(changedPath));
    for (const listener of listeners) {
      try {
        listener(runId);
      } catch (error) {
        log.debug("trace change listener threw", { error: formatError(error) });
      }
    }
  });
  watcher.on("error", (error: unknown) => {
    log.debug("trace watcher error", { error: formatError(error) });
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async close() {
      listeners.clear();
      watchers.delete(appRoot);
      await watcher.close();
    },
  };
}
