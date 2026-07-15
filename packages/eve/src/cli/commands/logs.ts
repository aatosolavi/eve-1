import { open, watch } from "node:fs/promises";

import { listLocalSessions, type LocalSessionSummary } from "#internal/workflow/local-sessions.js";
import { listSessionLogFiles, type SessionLogFile } from "#internal/session-logs/files.js";

interface LogsCliOutput {
  log(message: string): void;
  write(text: string): void;
}

export interface LogsCommandDependencies {
  listFiles(appRoot: string): Promise<readonly SessionLogFile[]>;
  listSessions(appRoot: string): Promise<readonly LocalSessionSummary[]>;
  tail(
    path: string,
    options: {
      readonly follow: boolean;
      readonly lines: number;
      readonly write: (text: string) => void;
    },
  ): Promise<void>;
}

const defaultDependencies: LogsCommandDependencies = {
  listFiles: listSessionLogFiles,
  listSessions: listLocalSessions,
  tail: tailSessionLogFile,
};

export async function runLogsListCommand(
  output: Pick<LogsCliOutput, "log">,
  appRoot: string,
  dependencies: LogsCommandDependencies = defaultDependencies,
): Promise<void> {
  const [files, sessions] = await Promise.all([
    dependencies.listFiles(appRoot),
    dependencies.listSessions(appRoot),
  ]);
  if (files.length === 0) {
    output.log("No local session logs found.");
    return;
  }

  const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
  const rows = [...files]
    .sort(
      (left, right) =>
        resolveUpdatedAt(right, sessionsById).getTime() -
        resolveUpdatedAt(left, sessionsById).getTime(),
    )
    .map((file) => {
      const session = sessionsById.get(file.sessionId);
      return [
        file.sessionId,
        session?.status ?? "unknown",
        resolveUpdatedAt(file, sessionsById).toISOString(),
        session?.title ?? "",
      ];
    });
  output.log(renderTable(["SESSION ID", "STATUS", "UPDATED", "TITLE"], rows));
}

export async function runLogsTailCommand(
  output: LogsCliOutput,
  appRoot: string,
  sessionId: string | undefined,
  options: { readonly follow: boolean; readonly lines: number },
  dependencies: LogsCommandDependencies = defaultDependencies,
): Promise<void> {
  if (!Number.isInteger(options.lines) || options.lines < 1) {
    throw new Error("Log line count must be a positive integer.");
  }

  const files = await dependencies.listFiles(appRoot);
  const selected =
    sessionId === undefined
      ? await selectMostRecentlyUsedLog(files, appRoot, dependencies)
      : files.find((file) => file.sessionId === sessionId);
  if (selected === undefined) {
    output.log(
      sessionId === undefined
        ? "No local session logs found."
        : `Local session log ${sessionId} was not found.`,
    );
    return;
  }

  await dependencies.tail(selected.path, {
    follow: options.follow,
    lines: options.lines,
    write: (text) => output.write(text),
  });
}

async function selectMostRecentlyUsedLog(
  files: readonly SessionLogFile[],
  appRoot: string,
  dependencies: LogsCommandDependencies,
): Promise<SessionLogFile | undefined> {
  if (files.length === 0) {
    return undefined;
  }
  const filesBySessionId = new Map(files.map((file) => [file.sessionId, file]));
  const sessions = await dependencies.listSessions(appRoot);
  for (const session of sessions) {
    const file = filesBySessionId.get(session.sessionId);
    if (file !== undefined) {
      return file;
    }
  }
  return undefined;
}

function resolveUpdatedAt(
  file: SessionLogFile,
  sessionsById: ReadonlyMap<string, LocalSessionSummary>,
): Date {
  return sessionsById.get(file.sessionId)?.updatedAt ?? file.modifiedAt;
}

/** Prints the last N lines and follows subsequent appends until Ctrl-C. */
export async function tailSessionLogFile(
  path: string,
  options: {
    readonly follow: boolean;
    readonly lines: number;
    readonly write: (text: string) => void;
  },
): Promise<void> {
  const abortController = new AbortController();
  const onInterrupt = () => abortController.abort();
  const changes = options.follow ? watch(path, { signal: abortController.signal }) : undefined;

  if (options.follow) {
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
  }

  try {
    const initial = await readLastLines(path, options.lines);
    if (initial.text.length > 0) {
      options.write(initial.text);
    }
    if (changes === undefined) {
      return;
    }

    let offset = initial.size;
    const decoder = new TextDecoder();
    offset = await writeAppendedBytes(path, offset, decoder, options.write);
    try {
      for await (const _change of changes) {
        offset = await writeAppendedBytes(path, offset, decoder, options.write);
      }
    } catch (error) {
      if (!abortController.signal.aborted || !isAbortError(error)) {
        throw error;
      }
    }
    const remainder = decoder.decode();
    if (remainder.length > 0) {
      options.write(remainder);
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    abortController.abort();
  }
}

async function readLastLines(
  path: string,
  lineCount: number,
): Promise<{
  readonly size: number;
  readonly text: string;
}> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    const size = metadata.size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    let position = size;
    const blockSize = 64 * 1_024;

    while (position > 0 && newlines <= lineCount) {
      const length = Math.min(blockSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const read = await handle.read(chunk, 0, length, position);
      const value = chunk.subarray(0, read.bytesRead);
      chunks.unshift(value);
      for (const byte of value) {
        if (byte === 0x0a) {
          newlines += 1;
        }
      }
    }

    const source = Buffer.concat(chunks);
    let index = source.length - 1;
    if (source[index] === 0x0a) {
      index -= 1;
    }
    let linesSeen = 0;
    let start = 0;
    for (; index >= 0; index -= 1) {
      if (source[index] !== 0x0a) {
        continue;
      }
      linesSeen += 1;
      if (linesSeen === lineCount) {
        start = index + 1;
        break;
      }
    }
    return { size, text: source.subarray(start).toString("utf8") };
  } finally {
    await handle.close();
  }
}

async function writeAppendedBytes(
  path: string,
  initialOffset: number,
  decoder: TextDecoder,
  write: (text: string) => void,
): Promise<number> {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    let offset = metadata.size < initialOffset ? 0 : initialOffset;
    while (offset < metadata.size) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, metadata.size - offset));
      const read = await handle.read(chunk, 0, chunk.length, offset);
      if (read.bytesRead === 0) {
        break;
      }
      offset += read.bytesRead;
      const text = decoder.decode(chunk.subarray(0, read.bytesRead), { stream: true });
      if (text.length > 0) {
        write(text);
      }
    }
    return offset;
  } finally {
    await handle.close();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  return [headers, ...rows]
    .map((row) =>
      row
        .map((value, index) => value.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
