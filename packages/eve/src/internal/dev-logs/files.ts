import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { isSafeDevelopmentLogId } from "#internal/dev-logs/protocol.js";

export const DEVELOPMENT_LOG_DIRECTORY_RELATIVE_PATH = ".eve/logs";

export interface DevelopmentLogFile {
  readonly logId: string;
  readonly modifiedAt: Date;
  readonly path: string;
}

export function resolveDevelopmentLogDirectory(appRoot: string): string {
  return join(appRoot, ".eve", "logs");
}

export function resolveDevelopmentLogPath(appRoot: string, logId: string): string {
  if (!isSafeDevelopmentLogId(logId)) {
    throw new Error(`Invalid local development log ID "${logId}".`);
  }
  return join(resolveDevelopmentLogDirectory(appRoot), `${logId}.log`);
}

/** Lists existing development log files without creating the log directory. */
export async function listDevelopmentLogFiles(
  appRoot: string,
): Promise<readonly DevelopmentLogFile[]> {
  const directory = resolveDevelopmentLogDirectory(appRoot);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  const files: DevelopmentLogFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".log")) continue;
    const logId = name.slice(0, -".log".length);
    if (!isSafeDevelopmentLogId(logId)) continue;
    const path = join(directory, name);
    const metadata = await stat(path);
    if (metadata.isFile()) {
      files.push({ logId, modifiedAt: metadata.mtime, path });
    }
  }
  return files;
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
