import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import type { BenchmarkRuntimeKind } from "../driver/index.js";
import { BENCHMARK_MODEL_KIND_ENV, type BenchmarkModelKind } from "../model-kind.js";
import type { BenchmarkRuntimeUrls } from "./types.js";

const SERVER_START_TIMEOUT_MS = 120_000;
const TERMINATE_GRACE_MS = 5_000;
const FORCE_KILL_GRACE_MS = 2_000;

export interface LocalRuntimeServerProcess {
  readonly url: Promise<string>;
  readRecordFile(): Promise<string | undefined>;
  stop(): Promise<void>;
}

export type StartLocalRuntimeServer = (
  runtimeKind: BenchmarkRuntimeKind,
  modelKind: BenchmarkModelKind,
) => LocalRuntimeServerProcess;

export class LocalRuntimeServerGroup {
  readonly #startServer: StartLocalRuntimeServer;
  readonly #serversByRuntime = new Map<BenchmarkRuntimeKind, LocalRuntimeServerProcess>();
  #servers: readonly LocalRuntimeServerProcess[] = [];
  #stopPromise: Promise<void> | null = null;

  constructor(startServer: StartLocalRuntimeServer = spawnLocalRuntimeServer) {
    this.#startServer = startServer;
  }

  async start(modelKind: BenchmarkModelKind): Promise<BenchmarkRuntimeUrls> {
    if (this.#servers.length !== 0) {
      throw new Error("The local benchmark servers have already been started.");
    }

    try {
      const inline = this.#startAndTrack("inline", modelKind);
      const workflow = this.#startAndTrack("workflow", modelKind);
      const temporal = this.#startAndTrack("temporal", modelKind);
      const [inlineUrl, workflowUrl, temporalUrl] = await Promise.all([
        inline.url,
        workflow.url,
        temporal.url,
      ]);
      return {
        inline: inlineUrl,
        temporal: temporalUrl,
        workflow: workflowUrl,
      };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopPromise ??= Promise.all(
      this.#servers.map(async (server) => await server.stop()),
    ).then(() => undefined);
    await this.#stopPromise;
  }

  async readRecordFile(runtimeKind: BenchmarkRuntimeKind): Promise<string | undefined> {
    const server = this.#serversByRuntime.get(runtimeKind);
    if (server === undefined) {
      throw new Error(`Cannot read ${runtimeKind} benchmark records before its server starts.`);
    }
    return await server.readRecordFile();
  }

  #startAndTrack(
    runtimeKind: BenchmarkRuntimeKind,
    modelKind: BenchmarkModelKind,
  ): LocalRuntimeServerProcess {
    const server = this.#startServer(runtimeKind, modelKind);
    this.#servers = [...this.#servers, server];
    this.#serversByRuntime.set(runtimeKind, server);
    return server;
  }
}

export function parseServerListeningLine(line: string): string | undefined {
  const plain = stripVTControlCharacters(line).trimEnd();
  const match = /^(?:\[START\] )?server listening at (https?:\/\/\S+)$/.exec(plain);
  const rawUrl = match?.[1];
  if (rawUrl === undefined) return undefined;

  try {
    return new URL(rawUrl).toString();
  } catch {
    return undefined;
  }
}

function spawnLocalRuntimeServer(
  runtimeKind: BenchmarkRuntimeKind,
  modelKind: BenchmarkModelKind,
): LocalRuntimeServerProcess {
  const ownedTempDirectory = mkdtempSync(join(tmpdir(), `eve-loop-benchmark-${runtimeKind}-`));
  const recordPath = join(ownedTempDirectory, "records.jsonl");
  const child = (() => {
    try {
      return spawn("eve", ["start", "--host", "127.0.0.1", "--port", "0"], {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          [BENCHMARK_MODEL_KIND_ENV]: modelKind,
          EVE_LOOP_BENCHMARK_RECORD_PATH: recordPath,
          EVE_LOOP_BENCHMARK_RUNTIME: runtimeKind,
          EVE_LOOP_BENCHMARK_TARGET: "local",
          WORKFLOW_LOCAL_DATA_DIR: join(ownedTempDirectory, "workflow-data"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      rmSync(ownedTempDirectory, { force: true, recursive: true });
      throw error;
    }
  })();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let capturedStdout = "";
  let capturedStderr = "";
  let lineBuffer = "";
  let readySettled = false;

  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });

  const url = new Promise<string>((resolveUrl, rejectUrl) => {
    const timeout = setTimeout(() => {
      rejectReady(
        new Error(
          formatStartError(runtimeKind, "timed out before printing its server URL", {
            stderr: capturedStderr,
            stdout: capturedStdout,
          }),
        ),
      );
    }, SERVER_START_TIMEOUT_MS);

    const settle = (callback: () => void) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(timeout);
      child.off("error", rejectReady);
      child.off("exit", handleEarlyExit);
      callback();
    };

    function rejectReady(error: unknown) {
      settle(() => rejectUrl(error));
    }

    function handleEarlyExit(code: number | null, signal: NodeJS.Signals | null) {
      rejectReady(
        new Error(
          formatStartError(
            runtimeKind,
            `exited before printing its server URL, code ${String(code)}, signal ${String(signal)}`,
            { stderr: capturedStderr, stdout: capturedStdout },
          ),
        ),
      );
    }

    child.stdout.on("data", (chunk: string) => {
      capturedStdout = appendCaptured(capturedStdout, chunk);
      process.stderr.write(`[${runtimeKind} stdout] ${chunk}`);
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsedUrl = parseServerListeningLine(line);
        if (parsedUrl !== undefined) {
          settle(() => resolveUrl(parsedUrl));
          return;
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      capturedStderr = appendCaptured(capturedStderr, chunk);
      process.stderr.write(`[${runtimeKind} stderr] ${chunk}`);
    });
    child.once("error", rejectReady);
    child.once("exit", handleEarlyExit);
  });

  let stopPromise: Promise<void> | null = null;
  return {
    async readRecordFile() {
      try {
        return await readFile(recordPath, "utf8");
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return undefined;
        throw error;
      }
    },
    async stop() {
      stopPromise ??= terminateProcess(child, exited).finally(async () => {
        await rm(ownedTempDirectory, { force: true, recursive: true });
      });
      await stopPromise;
    },
    url,
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function terminateProcess(
  child: ReturnType<typeof spawn>,
  exited: Promise<void>,
): Promise<void> {
  if (child.pid === undefined || hasExited(child)) {
    destroyProcessPipes(child);
    return;
  }

  signalProcess(child, "SIGTERM");
  await Promise.race([exited, sleep(TERMINATE_GRACE_MS)]);
  if (!hasExited(child)) {
    signalProcess(child, "SIGKILL");
    await Promise.race([exited, sleep(FORCE_KILL_GRACE_MS)]);
  }

  destroyProcessPipes(child);
}

function signalProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function hasExited(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function destroyProcessPipes(child: ReturnType<typeof spawn>): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
}

function appendCaptured(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= 32_000 ? combined : combined.slice(-32_000);
}

function formatStartError(
  runtimeKind: BenchmarkRuntimeKind,
  reason: string,
  output: { readonly stderr: string; readonly stdout: string },
): string {
  return [
    `${runtimeKind} eve start ${reason}.`,
    `stdout:\n${output.stdout}`,
    `stderr:\n${output.stderr}`,
  ].join("\n\n");
}
