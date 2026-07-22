import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CapturedSpan } from "#internal/tracing/captured-span.js";
import { TraceStore } from "#internal/tracing/trace-store.js";
import { getTraceWatcher } from "#internal/nitro/host/dev-trace-viewer/trace-watcher.js";

function turnSpan(runId: string): CapturedSpan[] {
  return [
    {
      traceId: `${runId}-t`,
      spanId: `${runId}-root`,
      name: "ai.eve.turn",
      kind: 0,
      startTimeUnixNano: "0",
      endTimeUnixNano: String(50 * 1_000_000),
      startMillis: 0,
      endMillis: 50,
      attributes: { "eve.session.id": runId },
    },
  ];
}

function nextChange(subscribe: (l: (runId: string) => void) => () => void): Promise<string> {
  return new Promise<string>((resolve) => {
    const unsubscribe = subscribe((runId) => {
      unsubscribe();
      resolve(runId);
    });
  });
}

describe("getTraceWatcher", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-trace-watch-"));
  });

  afterEach(async () => {
    await getTraceWatcher(appRoot).close();
    await rm(appRoot, { recursive: true, force: true });
  });

  it("notifies subscribers with the run id when a trace segment is written", async () => {
    const watcher = getTraceWatcher(appRoot);
    const changed = nextChange((listener) => watcher.subscribe(listener));

    // Give chokidar a moment to attach before the write.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new TraceStore(appRoot).write("sess-live", turnSpan("sess-live"));

    expect(await changed).toBe("sess-live");
  });

  it("returns the same shared watcher instance per app root", () => {
    expect(getTraceWatcher(appRoot)).toBe(getTraceWatcher(appRoot));
  });
});
