import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import type { BenchmarkRuntimeKind } from "../driver/index.js";
import { BENCHMARK_MODEL_KIND_ENV, type BenchmarkModelKind } from "../model-kind.js";

const SERVER_START_TIMEOUT_MS = 120_000;
const TERMINATE_GRACE_MS = 10_000;
const FORCE_KILL_GRACE_MS = 2_000;
const VERBOSE_LOGS_ENV = "EVE_LOOP_BENCHMARK_VERBOSE";

export interface LocalRuntimeServerProcess {
  readonly url: Promise<string>;
  readRecordFile(): Promise<string | undefined>;
  stop(): Promise<void>;
}

export type StartLocalRuntimeServer = (
  runtimeKind: BenchmarkRuntimeKind,
  modelKind: BenchmarkModelKind,
) => LocalRuntimeServerProcess;

/** A handle to one running local benchmark runtime and its owned record file. */
export interface LocalRuntimeServerLease<
  RuntimeKind extends BenchmarkRuntimeKind = BenchmarkRuntimeKind,
> {
  readonly runtimeKind: RuntimeKind;
  readonly targetUrl: string;
  readRecordFile(): Promise<string | undefined>;
  stop(): Promise<void>;
}

interface ActiveLocalRuntime {
  readonly leaseId: symbol;
  readonly process: LocalRuntimeServerProcess;
  readonly runtimeKind: BenchmarkRuntimeKind;
  stopPromise: Promise<void> | null;
}

/** Owns at most one local benchmark runtime process at a time. */
export class LocalRuntimeServerHost {
  readonly #startServer: StartLocalRuntimeServer;
  #active: ActiveLocalRuntime | null = null;

  constructor(startServer: StartLocalRuntimeServer = spawnLocalRuntimeServer) {
    this.#startServer = startServer;
  }

  async acquire<RuntimeKind extends BenchmarkRuntimeKind>(
    runtimeKind: RuntimeKind,
    modelKind: BenchmarkModelKind,
  ): Promise<LocalRuntimeServerLease<RuntimeKind>> {
    if (this.#active !== null) {
      throw new Error(
        `The local benchmark server host already has an active ${this.#active.runtimeKind} runtime.`,
      );
    }

    const process = this.#startServer(runtimeKind, modelKind);
    const leaseId = Symbol(runtimeKind);
    const active: ActiveLocalRuntime = {
      leaseId,
      process,
      runtimeKind,
      stopPromise: null,
    };
    this.#active = active;

    let targetUrl: string;
    try {
      targetUrl = await process.url;
    } catch (error) {
      try {
        await this.#stopLease(leaseId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `The ${runtimeKind} local benchmark server failed to start and cleanup also failed.`,
        );
      }
      throw error;
    }

    if (this.#active !== active || active.stopPromise !== null) {
      await this.#stopLease(leaseId);
      throw new Error(`The ${runtimeKind} local benchmark server stopped before it became ready.`);
    }

    return {
      async readRecordFile() {
        return await process.readRecordFile();
      },
      runtimeKind,
      stop: async () => {
        await this.#stopLease(leaseId);
      },
      targetUrl,
    };
  }

  async stop(): Promise<void> {
    const leaseId = this.#active?.leaseId;
    if (leaseId === undefined) return;
    await this.#stopLease(leaseId);
  }

  async #stopLease(leaseId: symbol): Promise<void> {
    const active = this.#active;
    if (active === null || active.leaseId !== leaseId) return;

    const stopPromise =
      active.stopPromise ??
      Promise.resolve()
        .then(async () => await active.process.stop())
        .then(() => {
          if (this.#active?.leaseId === leaseId) {
            this.#active = null;
          }
        });
    active.stopPromise = stopPromise;
    await stopPromise;
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

/** Streams child-process logs only when local benchmark diagnostics are explicitly enabled. */
export function shouldStreamLocalRuntimeLogs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[VERBOSE_LOGS_ENV] === "1";
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
  const streamLogs = shouldStreamLocalRuntimeLogs();

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
      if (streamLogs) process.stderr.write(`[${runtimeKind} stdout] ${chunk}`);
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
      if (streamLogs) process.stderr.write(`[${runtimeKind} stderr] ${chunk}`);
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
      stopPromise ??= terminateProcess(child, exited, runtimeKind).then(async () => {
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
  runtimeKind: BenchmarkRuntimeKind,
): Promise<void> {
  if (child.pid === undefined || hasExited(child)) {
    destroyProcessPipes(child);
    return;
  }

  try {
    await terminateLocalRuntimeProcess({
      exited,
      hasExited: () => hasExited(child),
      runtimeKind,
      signal: (signal) => signalProcess(child, signal),
    });
    forceKillResidualLocalRuntimeProcessGroup(child.pid);
  } finally {
    destroyProcessPipes(child);
  }
}

/** Terminates one local runtime and rejects unless its process exit is observed. */
export async function terminateLocalRuntimeProcess(
  input: {
    readonly exited: Promise<void>;
    readonly hasExited: () => boolean;
    readonly runtimeKind: BenchmarkRuntimeKind;
    readonly signal: (signal: NodeJS.Signals) => void;
  },
  waitForExit: (exited: Promise<void>, milliseconds: number) => Promise<void> = waitForProcessExit,
): Promise<void> {
  if (input.hasExited()) return;

  input.signal("SIGTERM");
  await waitForExit(input.exited, TERMINATE_GRACE_MS);
  if (input.hasExited()) return;

  input.signal("SIGKILL");
  await waitForExit(input.exited, FORCE_KILL_GRACE_MS);
  if (input.hasExited()) return;

  throw new Error(
    `The ${input.runtimeKind} local benchmark server did not exit within ${String(FORCE_KILL_GRACE_MS / 1_000)} seconds after SIGKILL.`,
  );
}

async function waitForProcessExit(exited: Promise<void>, milliseconds: number): Promise<void> {
  const controller = new AbortController();
  const timeout = sleep(milliseconds, undefined, {
    ref: false,
    signal: controller.signal,
  }).catch((error: unknown) => {
    if (!controller.signal.aborted) throw error;
  });

  try {
    await Promise.race([exited, timeout]);
  } finally {
    controller.abort();
  }
}

function signalProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  const signalProcessGroup = shouldSignalLocalRuntimeProcessGroup(signal);
  try {
    if (signalProcessGroup) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

/** Graceful shutdown targets eve; forced cleanup reaps its detached Unix process group. */
export function shouldSignalLocalRuntimeProcessGroup(
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && signal === "SIGKILL";
}

/** Reaps descendants left in the owned detached group after the eve parent exits. */
export function forceKillResidualLocalRuntimeProcessGroup(
  processGroupId: number,
  platform: NodeJS.Platform = process.platform,
  kill: (pid: number, signal: NodeJS.Signals) => boolean = process.kill,
): void {
  if (platform === "win32") return;
  try {
    kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) throw error;
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
