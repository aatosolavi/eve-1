import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { isSafeSessionLogId } from "#internal/session-logs/protocol.js";

export const SESSION_LOG_DIRECTORY_RELATIVE_PATH = ".eve/logs";

export interface SessionLogFile {
  readonly modifiedAt: Date;
  readonly path: string;
  readonly sessionId: string;
}

export function resolveSessionLogDirectory(appRoot: string): string {
  return join(appRoot, ".eve", "logs");
}

export function resolveSessionLogPath(appRoot: string, sessionId: string): string {
  if (!isSafeSessionLogId(sessionId)) {
    throw new Error(`Invalid local session ID "${sessionId}".`);
  }
  return join(resolveSessionLogDirectory(appRoot), `${sessionId}.log`);
}

/** Lists existing session log files without creating the log directory. */
export async function listSessionLogFiles(appRoot: string): Promise<readonly SessionLogFile[]> {
  const directory = resolveSessionLogDirectory(appRoot);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  const files: SessionLogFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".log")) {
      continue;
    }
    const sessionId = name.slice(0, -".log".length);
    if (!isSafeSessionLogId(sessionId)) {
      continue;
    }
    const path = join(directory, name);
    const metadata = await stat(path);
    if (metadata.isFile()) {
      files.push({ modifiedAt: metadata.mtime, path, sessionId });
    }
  }
  return files;
}

function isErrnoException(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
