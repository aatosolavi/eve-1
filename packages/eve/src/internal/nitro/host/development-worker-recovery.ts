import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { DevelopmentRuntimeArtifactsWorker } from "#internal/nitro/dev-runtime-worker-artifacts.js";

export function isRestorableDevelopmentWorker(
  worker: DevelopmentRuntimeArtifactsWorker,
  appRoot: string,
): boolean {
  const hostRoot = join(appRoot, ".eve", "dev-hosts");
  return (
    isPathInside(worker.workspaceRoot, hostRoot) &&
    isPathInside(worker.entry, worker.workspaceRoot) &&
    existsSync(worker.entry)
  );
}

function isPathInside(path: string, parent: string): boolean {
  const pathRelativeToParent = relative(parent, path);
  return (
    pathRelativeToParent !== ".." &&
    !pathRelativeToParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathRelativeToParent)
  );
}
