import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";
import { listLocalSessions } from "#internal/workflow/local-sessions.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true })),
  );
});

describe("local session listing", () => {
  it("reads only eve sessions from the app's local Workflow World", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-local-sessions-"));
    temporaryRoots.push(appRoot);
    const world = createWorld({
      dataDir: resolveLocalWorkflowWorldDataDirectory(appRoot),
      recoverActiveRuns: false,
    });

    const first = await createRun(world, {
      "$eve.title": "First session",
      "$eve.trigger": "http",
      "$eve.type": "session",
    });
    await createRun(world, { "$eve.type": "subagent" });
    const second = await createRun(world, {
      "$eve.title": "Second session",
      "$eve.type": "session",
    });
    await world.events.create(first, { eventType: "run_started" });
    await world.close?.();

    await expect(listLocalSessions(appRoot)).resolves.toMatchObject([
      { sessionId: first, title: "First session", trigger: "http" },
      { sessionId: second, title: "Second session" },
    ]);
  });

  it("does not create local Workflow state while inspecting an empty app", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-local-sessions-"));
    temporaryRoots.push(appRoot);

    await expect(listLocalSessions(appRoot)).resolves.toEqual([]);
  });
});

async function createRun(
  world: ReturnType<typeof createWorld>,
  attributes: Record<string, string>,
): Promise<string> {
  const result = await world.events.create(null, {
    eventData: {
      allowReservedAttributes: true,
      attributes,
      deploymentId: "generation-1",
      input: new Uint8Array(),
      workflowName: workflowEntryReference.workflowId,
    },
    eventType: "run_created",
    specVersion: 5,
  });
  if (result.run === undefined) throw new Error("Local World did not return the created run.");
  return result.run.runId;
}
