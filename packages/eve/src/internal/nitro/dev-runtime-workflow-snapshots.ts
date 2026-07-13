import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { hydrateWorkflowArguments } from "#compiled/@workflow/core/serialization.js";

const EVE_TURN_WORKFLOW_NAME = "workflow//eve//turnWorkflow";
const ACTIVE_WORKFLOW_RUN_STATUSES = new Set(["pending", "running"]);

export async function collectActiveTurnWorkflowSnapshotRoots(input: {
  readonly appRoot: string;
}): Promise<readonly string[]> {
  const workflowDataDirectory = join(input.appRoot, ".workflow-data");
  const storeEntries = await readDirectoryEntries(workflowDataDirectory);
  const snapshotRoots = new Set<string>();

  await Promise.all(
    storeEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const runsDirectory = join(workflowDataDirectory, entry.name, "runs");
        const runEntries = await readDirectoryEntries(runsDirectory);

        await Promise.all(
          runEntries
            .filter((runEntry) => runEntry.isFile())
            .map(async (runEntry) => {
              const snapshotRoot = await readActiveTurnWorkflowSnapshotRoot({
                path: join(runsDirectory, runEntry.name),
                snapshotsDirectory: join(input.appRoot, ".eve", "dev-runtime", "snapshots"),
              });
              if (snapshotRoot !== undefined) {
                snapshotRoots.add(snapshotRoot);
              }
            }),
        );
      }),
  );

  return [...snapshotRoots];
}

async function readActiveTurnWorkflowSnapshotRoot(input: {
  readonly path: string;
  readonly snapshotsDirectory: string;
}): Promise<string | undefined> {
  const run = parseRunRecord(await readFile(input.path, "utf8"));
  if (run === undefined || !isActiveEveTurnWorkflowRun(run)) {
    return undefined;
  }

  const serializedInput = parseWorldLocalUint8Array(run.input);
  if (serializedInput === undefined) {
    return readDiskArtifactSnapshotRoot(run.input, input.snapshotsDirectory);
  }

  try {
    const workflowInput = await hydrateWorkflowArguments(
      serializedInput,
      typeof run.runId === "string" ? run.runId : "",
      undefined,
    );
    return readDiskArtifactSnapshotRoot(workflowInput, input.snapshotsDirectory);
  } catch {
    return undefined;
  }
}

function readDiskArtifactSnapshotRoot(
  value: unknown,
  snapshotsDirectory: string,
): string | undefined {
  const workflowInput = Array.isArray(value) ? value[0] : value;
  if (!isObjectRecord(workflowInput)) {
    return undefined;
  }

  const stepInput = workflowInput.stepInput;
  const serializedContext = isObjectRecord(stepInput)
    ? stepInput.serializedContext
    : workflowInput.serializedContext;
  if (!isObjectRecord(serializedContext)) {
    return undefined;
  }

  const bundle = serializedContext["eve.bundle"];
  if (!isObjectRecord(bundle) || !isObjectRecord(bundle.source)) {
    return undefined;
  }

  const source = bundle.source;
  if (source.kind !== "disk" || typeof source.appRoot !== "string" || source.appRoot.length === 0) {
    return undefined;
  }

  const normalizedAppRoot = source.appRoot.replaceAll("\\", sep);
  const relativeAppRoot = relative(resolve(snapshotsDirectory), resolve(normalizedAppRoot));
  if (
    relativeAppRoot.length === 0 ||
    relativeAppRoot === ".." ||
    relativeAppRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeAppRoot)
  ) {
    return undefined;
  }

  const [snapshotName, sourceDirectory] = relativeAppRoot.split(sep);
  return snapshotName === undefined || snapshotName.length === 0 || sourceDirectory !== "source"
    ? undefined
    : join(snapshotsDirectory, snapshotName);
}

function parseWorldLocalUint8Array(value: unknown): Uint8Array | undefined {
  if (!isObjectRecord(value) || value.__type !== "Uint8Array" || typeof value.data !== "string") {
    return undefined;
  }

  return Buffer.from(value.data, "base64");
}

function isActiveEveTurnWorkflowRun(run: Record<string, unknown>): boolean {
  const workflowName =
    typeof run.workflowName === "string"
      ? run.workflowName
      : typeof run.workflowId === "string"
        ? run.workflowId
        : undefined;
  return (
    workflowName === EVE_TURN_WORKFLOW_NAME &&
    typeof run.status === "string" &&
    ACTIVE_WORKFLOW_RUN_STATUSES.has(run.status)
  );
}

async function readDirectoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function parseRunRecord(source: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(source) as unknown;
    return isObjectRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
