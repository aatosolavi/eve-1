import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { deserialize, serialize } from "node:v8";

const WORKER_DATA_FILE = "worker-data.bin";
const WORKER_METADATA_FILE = "worker.json";

export interface DevelopmentRuntimeArtifactsWorker {
  readonly entry: string;
  readonly workerData: Readonly<Record<string, unknown>>;
  readonly workspaceRoot: string;
}

export async function writeDevelopmentRuntimeArtifactsWorker(input: {
  readonly entry: string;
  readonly snapshotRoot: string;
  readonly workerData: Readonly<Record<string, unknown>>;
  readonly workspaceRoot: string;
}): Promise<void> {
  await writeFile(join(input.snapshotRoot, WORKER_DATA_FILE), serialize(input.workerData));
  await writeFile(
    join(input.snapshotRoot, WORKER_METADATA_FILE),
    `${JSON.stringify({ entry: input.entry, workspaceRoot: input.workspaceRoot })}\n`,
  );
}

export async function copyDevelopmentRuntimeArtifactsWorker(input: {
  readonly sourceSnapshotRoot: string;
  readonly targetSnapshotRoot: string;
}): Promise<void> {
  const worker = await readDevelopmentRuntimeArtifactsWorker(input.sourceSnapshotRoot);
  if (worker === undefined) {
    throw new Error(
      `Development generation "${basename(input.sourceSnapshotRoot)}" has no worker metadata.`,
    );
  }
  await writeDevelopmentRuntimeArtifactsWorker({
    ...worker,
    snapshotRoot: input.targetSnapshotRoot,
  });
}

export async function readDevelopmentRuntimeArtifactsWorker(
  snapshotRoot: string,
): Promise<DevelopmentRuntimeArtifactsWorker | undefined> {
  const metadataPath = join(snapshotRoot, WORKER_METADATA_FILE);
  const dataPath = join(snapshotRoot, WORKER_DATA_FILE);
  let metadataSource: string;
  let workerDataSource: Buffer;
  try {
    [metadataSource, workerDataSource] = await Promise.all([
      readFile(metadataPath, "utf8"),
      readFile(dataPath),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      !existsSync(metadataPath) &&
      !existsSync(dataPath)
    ) {
      return undefined;
    }
    throw error;
  }
  const metadata = parseJsonObject(metadataSource);
  const workerData = deserialize(workerDataSource) as unknown;
  if (
    metadata === undefined ||
    typeof metadata.entry !== "string" ||
    typeof metadata.workspaceRoot !== "string" ||
    !isObjectRecord(workerData)
  ) {
    throw new Error(
      `Development generation "${basename(snapshotRoot)}" has invalid worker metadata.`,
    );
  }
  return {
    entry: metadata.entry,
    workerData,
    workspaceRoot: metadata.workspaceRoot,
  };
}

function parseJsonObject(source: string): Record<string, unknown> | undefined {
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
