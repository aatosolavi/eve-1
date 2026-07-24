import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { getWorldImport } from "@workflow/utils";

import type { EveNextConfig, WithEveOptions } from "./index.js";

export const NEXT_WORKFLOW_TARGET_ENV = "EVE_INTERNAL_NEXT_WORKFLOW_TARGET";
export const NEXT_WORKFLOW_TARGET_FILE = ".eve/next-workflow-target";

export interface NextWorkflowTargetDescriptor {
  readonly namespace?: string;
  readonly nextRootFromAgentRoot: string;
  readonly version: 1;
  readonly workflows: Readonly<Record<string, string>>;
  readonly worldPackage: string;
}

interface WorkflowManifestEntry {
  readonly workflowId?: unknown;
}

interface WorkflowManifest {
  readonly workflows?: Readonly<Record<string, Readonly<Record<string, WorkflowManifestEntry>>>>;
}

const MANIFEST_PATHS = [
  "app/.well-known/workflow/v1/manifest.json",
  "src/app/.well-known/workflow/v1/manifest.json",
  "public/.well-known/workflow/v1/manifest.json",
] as const;

async function readWorkflowManifest(nextRoot: string): Promise<WorkflowManifest> {
  for (const relativePath of MANIFEST_PATHS) {
    try {
      return JSON.parse(await readFile(join(nextRoot, relativePath), "utf8")) as WorkflowManifest;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  throw new Error(
    "withEve workflowBridge requires withWorkflow() to emit a Workflow manifest before eve configuration resolves.",
  );
}

function resolveAllowlistedWorkflows(
  manifest: WorkflowManifest,
  allowlist: readonly string[],
): Readonly<Record<string, string>> {
  if (allowlist.length === 0) {
    throw new Error("withEve workflowBridge must contain at least one workflow name.");
  }

  const entries = new Map<string, string[]>();
  for (const exports of Object.values(manifest.workflows ?? {})) {
    for (const [exportName, entry] of Object.entries(exports)) {
      if (typeof entry.workflowId !== "string") continue;
      const ids = entries.get(exportName) ?? [];
      ids.push(entry.workflowId);
      entries.set(exportName, ids);
    }
  }

  const workflows: Record<string, string> = {};
  for (const name of allowlist) {
    if (name.trim() !== name || name.length === 0) {
      throw new Error(
        `withEve workflowBridge contains invalid workflow name ${JSON.stringify(name)}.`,
      );
    }
    if (name in workflows) {
      throw new Error(
        `withEve workflowBridge contains duplicate workflow name ${JSON.stringify(name)}.`,
      );
    }

    const ids = entries.get(name) ?? [];
    if (ids.length === 0) {
      throw new Error(`withEve workflowBridge workflow ${JSON.stringify(name)} was not found.`);
    }
    if (ids.length > 1) {
      throw new Error(
        `withEve workflowBridge workflow ${JSON.stringify(name)} is ambiguous because multiple modules export it.`,
      );
    }
    workflows[name] = ids[0]!;
  }
  return workflows;
}

async function readWorkflowNamespace(nextRoot: string): Promise<string | undefined> {
  for (const relativePath of MANIFEST_PATHS) {
    try {
      const config = JSON.parse(
        await readFile(join(nextRoot, relativePath, "..", "config.json"), "utf8"),
      ) as { workflows?: { experimentalTriggers?: Array<{ topic?: unknown }> } };
      for (const trigger of config.workflows?.experimentalTriggers ?? []) {
        if (typeof trigger.topic !== "string") continue;
        const match = /^__([a-z][a-z0-9]*)_wkf_workflow_\*$/.exec(trigger.topic);
        if (match !== null) return match[1];
        if (trigger.topic === "__wkf_workflow_*") return undefined;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return undefined;
}

function readConfigEnvironment(config: EveNextConfig, name: string): string | undefined {
  const configured = config.env?.[name];
  return typeof configured === "string" && configured.length > 0
    ? configured
    : process.env[name]?.trim() || undefined;
}

export async function resolveNextWorkflowTargetDescriptor(input: {
  readonly agentRoot: string;
  readonly nextConfig: EveNextConfig;
  readonly nextRoot: string;
  readonly workflowBridge: NonNullable<WithEveOptions["workflowBridge"]>;
}): Promise<NextWorkflowTargetDescriptor> {
  const targetWorld = readConfigEnvironment(input.nextConfig, "WORKFLOW_TARGET_WORLD");
  if (targetWorld === undefined) {
    throw new Error(
      "withEve workflowBridge could not determine the Workflow World selected by withWorkflow().",
    );
  }

  const descriptor: NextWorkflowTargetDescriptor = {
    nextRootFromAgentRoot: relative(input.agentRoot, input.nextRoot) || ".",
    version: 1,
    workflows: resolveAllowlistedWorkflows(
      await readWorkflowManifest(input.nextRoot),
      input.workflowBridge,
    ),
    worldPackage: getWorldImport({ WORKFLOW_TARGET_WORLD: targetWorld }),
  };
  const namespace = await readWorkflowNamespace(input.nextRoot);
  return namespace === undefined ? descriptor : { ...descriptor, namespace };
}

export function encodeNextWorkflowTargetDescriptor(
  descriptor: NextWorkflowTargetDescriptor,
): string {
  return Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64url");
}

export async function writeNextWorkflowTargetDescriptor(
  agentRoot: string,
  encodedDescriptor: string | undefined,
): Promise<void> {
  const path = join(agentRoot, NEXT_WORKFLOW_TARGET_FILE);
  if (encodedDescriptor === undefined) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(join(agentRoot, ".eve"), { recursive: true });
  await writeFile(path, `${encodedDescriptor}\n`);
}

export async function readNextWorkflowTargetDescriptor(
  agentRoot: string,
): Promise<NextWorkflowTargetDescriptor | undefined> {
  const environmentDescriptor = decodeNextWorkflowTargetDescriptor(
    process.env[NEXT_WORKFLOW_TARGET_ENV],
  );
  if (environmentDescriptor !== undefined) return environmentDescriptor;
  try {
    return decodeNextWorkflowTargetDescriptor(
      (await readFile(join(agentRoot, NEXT_WORKFLOW_TARGET_FILE), "utf8")).trim(),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function decodeNextWorkflowTargetDescriptor(
  source: string | undefined,
): NextWorkflowTargetDescriptor | undefined {
  if (source === undefined || source.length === 0) return undefined;
  const value = JSON.parse(Buffer.from(source, "base64url").toString("utf8")) as unknown;
  if (
    value === null ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("worldPackage" in value) ||
    typeof value.worldPackage !== "string" ||
    !("nextRootFromAgentRoot" in value) ||
    typeof value.nextRootFromAgentRoot !== "string" ||
    !("workflows" in value) ||
    value.workflows === null ||
    typeof value.workflows !== "object"
  ) {
    throw new Error("Invalid generated Next.js Workflow target descriptor.");
  }
  return value as NextWorkflowTargetDescriptor;
}
