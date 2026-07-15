import { existsSync } from "node:fs";

import type {
  WorkflowRunStatus,
  WorkflowRunWithoutData,
  World,
} from "#compiled/@workflow/world/index.js";
import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";

const EVE_SESSION_TYPE = "session";

export interface LocalSessionSummary {
  readonly createdAt: Date;
  readonly deploymentId: string;
  readonly errorCode: string | undefined;
  readonly sessionId: string;
  readonly status: WorkflowRunStatus;
  readonly title: string | undefined;
  readonly trigger: string | undefined;
  readonly updatedAt: Date;
}

/** Lists sessions persisted by this app's local Workflow World, newest first. */
export async function listLocalSessions(appRoot: string): Promise<readonly LocalSessionSummary[]> {
  return await withLocalWorld(appRoot, [], async (world) => {
    const sessions: LocalSessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await world.runs.list({
        pagination: { cursor, limit: 1_000, sortOrder: "desc" },
        resolveData: "none",
        workflowName: workflowEntryReference.workflowId,
      });
      for (const run of page.data) {
        const session = projectSession(run);
        if (session !== undefined) sessions.push(session);
      }
      cursor = page.hasMore ? (page.cursor ?? undefined) : undefined;
    } while (cursor !== undefined);
    return sessions.sort(compareSessionsMostRecentlyUpdatedFirst);
  });
}

function compareSessionsMostRecentlyUpdatedFirst(
  left: LocalSessionSummary,
  right: LocalSessionSummary,
): number {
  const byUpdatedAt = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (byUpdatedAt !== 0) return byUpdatedAt;
  const byCreatedAt = right.createdAt.getTime() - left.createdAt.getTime();
  return byCreatedAt !== 0 ? byCreatedAt : right.sessionId.localeCompare(left.sessionId);
}

async function withLocalWorld<T>(
  appRoot: string,
  missing: T,
  read: (world: World) => Promise<T>,
): Promise<T> {
  const dataDir = resolveLocalWorkflowWorldDataDirectory(appRoot);
  if (!existsSync(dataDir)) return missing;

  const world = createWorld({ dataDir, recoverActiveRuns: false });
  try {
    return await read(world);
  } finally {
    await world.close?.();
  }
}

function projectSession(run: WorkflowRunWithoutData): LocalSessionSummary | undefined {
  if (
    run.workflowName !== workflowEntryReference.workflowId ||
    run.attributes["$eve.type"] !== EVE_SESSION_TYPE
  ) {
    return undefined;
  }

  return {
    createdAt: run.createdAt,
    deploymentId: run.deploymentId,
    errorCode: run.errorCode,
    sessionId: run.runId,
    status: run.status,
    title: run.attributes["$eve.title"],
    trigger: run.attributes["$eve.trigger"],
    updatedAt: run.updatedAt,
  };
}
