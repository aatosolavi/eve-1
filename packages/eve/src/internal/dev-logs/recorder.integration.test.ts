import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { getWorkflowRunStreamId } from "#compiled/@workflow/core/util.js";
import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { DevelopmentLog } from "#internal/dev-logs/development-log.js";
import { resolveDevelopmentLogPath } from "#internal/dev-logs/files.js";
import { DevelopmentLogRecorder } from "#internal/dev-logs/recorder.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";

const createScratchDirectory = useTemporaryDirectories();

describe("development log recorder", () => {
  it("restarts a failed stream follower on the next durable write", async () => {
    const appRoot = await createScratchDirectory("eve-development-log-follower-");
    const world = createWorld({
      dataDir: resolveLocalWorkflowWorldDataDirectory(appRoot),
      recoverActiveRuns: false,
    });
    await world.start?.();
    const created = await world.events.create(null, {
      eventData: {
        allowReservedAttributes: true,
        attributes: { "$eve.type": "session" },
        deploymentId: "generation-a",
        input: new Uint8Array(),
        workflowName: workflowEntryReference.workflowId,
      },
      eventType: "run_created",
      specVersion: 5,
    });
    if (created.run === undefined) throw new Error("Local World did not return the created run.");
    const runId = created.run.runId;
    const streamName = getWorkflowRunStreamId(runId);
    await world.streams.write(runId, streamName, encodeStepStarted("turn_1"));

    const failedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("reader failed"));
      },
    });
    const getSpy = vi.spyOn(world.streams, "get").mockResolvedValueOnce(failedStream);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = await DevelopmentLog.open({ appRoot, logId: "dev-invocation" });
    const recorder = new DevelopmentLogRecorder({ log, world });
    try {
      recorder.observeSessionEventStream(runId, streamName);
      await vi.waitFor(() =>
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("failed to follow session events"),
          expect.any(Error),
        ),
      );
      getSpy.mockRestore();

      await world.streams.write(runId, streamName, encodeStepStarted("turn_2"));
      recorder.observeSessionEventStream(runId, streamName);

      await vi.waitFor(async () => {
        const source = await readFile(resolveDevelopmentLogPath(appRoot, "dev-invocation"), "utf8");
        expect(source).toContain("turn_2");
      });
    } finally {
      getSpy.mockRestore();
      errorSpy.mockRestore();
      await recorder.close();
      await log.close();
      await world.close?.();
    }
  });
});

function encodeStepStarted(turnId: string): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      data: { stepIndex: 0, turnId },
      meta: { at: "2026-07-16T18:00:00.000Z" },
      type: "step.started",
    })}\n`,
  );
}
