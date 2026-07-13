import { existsSync } from "node:fs";
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dehydrateWorkflowArguments } from "#compiled/@workflow/core/serialization.js";
import {
  activateDevelopmentRuntimeArtifactsSnapshot,
  pruneDevelopmentRuntimeArtifactsSnapshots,
} from "#internal/nitro/dev-runtime-artifacts.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();
const NOW = 1_000_000;
const OLD_SNAPSHOT_TIME = new Date(1_000);

describe("development runtime workflow snapshot retention", () => {
  it("preserves compressed root and turn workflow snapshots without retaining terminal history", async () => {
    const fixture = await createPruneFixture(["active-root", "active-turn", "completed", "stale"]);
    const runsDirectory = join(fixture.appRoot, ".workflow-data", "default", "runs");
    const eventsDirectory = join(fixture.appRoot, ".workflow-data", "default", "events");
    await mkdir(runsDirectory, { recursive: true });
    await mkdir(eventsDirectory, { recursive: true });

    const rootInput = await serializeWorkflowInput({
      serializedContext: createSerializedContext(fixture.snapshotRoots["active-root"]),
    });
    const turnInput = await serializeWorkflowInput({
      stepInput: {
        serializedContext: createSerializedContext(fixture.snapshotRoots["active-turn"]),
      },
    });
    const completedInput = await serializeWorkflowInput({
      serializedContext: createSerializedContext(fixture.snapshotRoots.completed),
    });

    await writeRun(runsDirectory, "active-root", {
      input: encodeWorldLocalUint8Array(rootInput),
      status: "running",
      workflowName: "workflow//eve//workflowEntry",
    });
    await writeRun(runsDirectory, "active-turn", {
      input: encodeWorldLocalUint8Array(turnInput),
      status: "running",
      workflowName: "workflow//eve//turnWorkflow",
    });
    await writeRun(runsDirectory, "completed", {
      input: encodeWorldLocalUint8Array(completedInput),
      status: "completed",
      workflowName: "workflow//eve//workflowEntry",
    });
    await writeFile(
      join(eventsDirectory, "completed-run-created.json"),
      `${JSON.stringify({
        eventData: { input: encodeWorldLocalUint8Array(completedInput) },
        eventType: "run_created",
        runId: "completed",
      })}\n`,
    );

    await prune(fixture.appRoot);

    await expect(readdir(fixture.snapshotsRoot)).resolves.toEqual(
      expect.arrayContaining(["active", "active-root", "active-turn"]),
    );
    expect(existsSync(requireSnapshotRoot(fixture.snapshotRoots, "completed"))).toBe(false);
    expect(existsSync(requireSnapshotRoot(fixture.snapshotRoots, "stale"))).toBe(false);
  });

  it.each([
    {
      name: "invalid serialized input",
      source: JSON.stringify({
        input: {
          __type: "Uint8Array",
          data: Buffer.from("zstd-not-valid").toString("base64"),
        },
        runId: "uncertain",
        status: "running",
        workflowName: "workflow//eve//workflowEntry",
      }),
    },
    {
      name: "malformed run JSON",
      source: '{"workflowName":"workflow//eve//workflowEntry",',
    },
  ])("aborts pruning for $name", async ({ source }) => {
    const fixture = await createPruneFixture(["uncertain", "stale"]);
    const runsDirectory = join(fixture.appRoot, ".workflow-data", "default", "runs");
    await mkdir(runsDirectory, { recursive: true });
    await writeFile(join(runsDirectory, "uncertain.json"), source);

    await expect(prune(fixture.appRoot)).rejects.toThrow();
    expect(existsSync(requireSnapshotRoot(fixture.snapshotRoots, "uncertain"))).toBe(true);
    expect(existsSync(requireSnapshotRoot(fixture.snapshotRoots, "stale"))).toBe(true);
  });
});

async function createPruneFixture(snapshotNames: readonly string[]): Promise<{
  readonly appRoot: string;
  readonly snapshotRoots: Readonly<Record<string, string>>;
  readonly snapshotsRoot: string;
}> {
  const appRoot = await createScratchDirectory("eve-dev-runtime-workflow-snapshots-");
  const snapshotsRoot = join(appRoot, ".eve", "dev-runtime", "snapshots");
  const snapshotRoots = Object.fromEntries(
    ["active", ...snapshotNames].map((name) => [name, join(snapshotsRoot, name)]),
  );

  for (const snapshotRoot of Object.values(snapshotRoots)) {
    await mkdir(snapshotRoot, { recursive: true });
    await writeFile(join(snapshotRoot, "marker.txt"), snapshotRoot);
    await utimes(snapshotRoot, OLD_SNAPSHOT_TIME, OLD_SNAPSHOT_TIME);
  }

  const activeSnapshotRoot = snapshotRoots.active;
  if (activeSnapshotRoot === undefined) {
    throw new Error("Missing active snapshot fixture.");
  }
  await activateDevelopmentRuntimeArtifactsSnapshot({
    appRoot,
    snapshot: {
      runtimeAppRoot: join(activeSnapshotRoot, "source", "app"),
      snapshotRoot: activeSnapshotRoot,
      snapshotSourceRoot: join(activeSnapshotRoot, "source"),
    },
  });

  return { appRoot, snapshotRoots, snapshotsRoot };
}

async function serializeWorkflowInput(value: Record<string, unknown>): Promise<Uint8Array> {
  const serialized = await dehydrateWorkflowArguments(
    [{ ...value, padding: "x".repeat(3_000) }],
    "wrun_test",
    undefined,
    [],
    globalThis,
    false,
    false,
    true,
  );
  if (!(serialized instanceof Uint8Array)) {
    throw new Error("Expected Workflow arguments to serialize as Uint8Array.");
  }
  expect(Buffer.from(serialized).subarray(0, 4).toString("utf8")).toMatch(/^(gzip|zstd)$/);
  return serialized;
}

function createSerializedContext(snapshotRoot: string | undefined): Record<string, unknown> {
  if (snapshotRoot === undefined) {
    throw new Error("Missing snapshot fixture.");
  }
  return {
    "eve.bundle": {
      source: {
        appRoot: join(snapshotRoot, "source", "app"),
        kind: "disk",
      },
    },
  };
}

function requireSnapshotRoot(
  snapshotRoots: Readonly<Record<string, string>>,
  name: string,
): string {
  const snapshotRoot = snapshotRoots[name];
  if (snapshotRoot === undefined) {
    throw new Error(`Missing snapshot fixture "${name}".`);
  }
  return snapshotRoot;
}

function encodeWorldLocalUint8Array(value: Uint8Array): {
  readonly __type: "Uint8Array";
  readonly data: string;
} {
  return {
    __type: "Uint8Array",
    data: Buffer.from(value).toString("base64"),
  };
}

async function writeRun(
  runsDirectory: string,
  runId: string,
  run: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(runsDirectory, `${runId}.json`), `${JSON.stringify({ ...run, runId })}\n`);
}

async function prune(appRoot: string): Promise<void> {
  await pruneDevelopmentRuntimeArtifactsSnapshots({
    appRoot,
    now: NOW,
    recentWindowMs: 0,
    retainCount: 0,
  });
}
