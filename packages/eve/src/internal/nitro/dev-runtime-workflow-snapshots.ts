import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { hydrateWorkflowArguments } from "#compiled/@workflow/core/serialization.js";

const EVE_WORKFLOW_NAME_PREFIX = "workflow//eve//";
const TERMINAL_WORKFLOW_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

export async function collectActiveWorkflowSnapshotRoots(input: {
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
              const snapshotRoot = await readActiveWorkflowSnapshotRoot(
                join(runsDirectory, runEntry.name),
              );
              if (snapshotRoot !== undefined) {
                snapshotRoots.add(snapshotRoot);
              }
            }),
        );
      }),
  );

  return [...snapshotRoots];
}

async function readActiveWorkflowSnapshotRoot(path: string): Promise<string | undefined> {
  const run = parseRunRecord(await readFile(path, "utf8"), path);
  if (!isEveWorkflowRun(run) || isTerminalWorkflowRun(run.status)) {
    return undefined;
  }

  const serializedInput = parseWorldLocalUint8Array(run.input);
  if (serializedInput === undefined) {
    return readDiskArtifactAppRoot(run.input, path);
  }

  let workflowInput: unknown;
  try {
    workflowInput = await hydrateWorkflowArguments(
      serializedInput,
      typeof run.runId === "string" ? run.runId : "",
      undefined,
    );
  } catch (error) {
    throw new Error(`Cannot decode active eve workflow run "${path}".`, { cause: error });
  }

  return readDiskArtifactAppRoot(workflowInput, path);
}

function readDiskArtifactAppRoot(value: unknown, path: string): string | undefined {
  const workflowInput = Array.isArray(value) ? value[0] : value;
  if (!isObjectRecord(workflowInput)) {
    throw new Error(`Active eve workflow run "${path}" has invalid input.`);
  }

  const stepInput = workflowInput.stepInput;
  const serializedContext = isObjectRecord(stepInput)
    ? stepInput.serializedContext
    : workflowInput.serializedContext;
  if (!isObjectRecord(serializedContext)) {
    throw new Error(`Active eve workflow run "${path}" has no serialized context.`);
  }

  const bundle = serializedContext["eve.bundle"];
  if (!isObjectRecord(bundle) || !isObjectRecord(bundle.source)) {
    throw new Error(`Active eve workflow run "${path}" has no serialized bundle source.`);
  }

  const source = bundle.source;
  if (source.kind !== "disk") {
    return undefined;
  }
  if (typeof source.appRoot !== "string" || source.appRoot.length === 0) {
    throw new Error(`Active eve workflow run "${path}" has an invalid disk artifact root.`);
  }

  return source.appRoot.replaceAll("\\", "/");
}

function parseWorldLocalUint8Array(value: unknown): Uint8Array | undefined {
  if (!isObjectRecord(value) || value.__type !== "Uint8Array" || typeof value.data !== "string") {
    return undefined;
  }

  return Buffer.from(value.data, "base64");
}

function isEveWorkflowRun(run: Record<string, unknown>): boolean {
  const workflowName =
    typeof run.workflowName === "string"
      ? run.workflowName
      : typeof run.workflowId === "string"
        ? run.workflowId
        : undefined;
  return workflowName?.startsWith(EVE_WORKFLOW_NAME_PREFIX) === true;
}

function isTerminalWorkflowRun(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_WORKFLOW_RUN_STATUSES.has(status);
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

function parseRunRecord(source: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Cannot parse workflow run "${path}".`, { cause: error });
  }

  if (!isObjectRecord(value)) {
    throw new Error(`Workflow run "${path}" is not a JSON object.`);
  }
  return value;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
