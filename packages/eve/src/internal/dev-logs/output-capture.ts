import type { WriteStream } from "node:tty";

import { contextStorage } from "#context/container.js";
import { DevelopmentLogSessionIdKey } from "#context/keys.js";
import { listenToSandboxOutput } from "#execution/sandbox/output-events.js";
import { canWriteDevelopmentLogs, writeDevelopmentLog } from "#internal/dev-logs/client.js";
import type { DevelopmentLogEvent } from "#internal/dev-logs/protocol.js";

const WORKER_OUTPUT_CAPTURE_KEY = Symbol.for("eve.development-log-output-capture");

interface DevelopmentLogCaptureGlobal {
  [WORKER_OUTPUT_CAPTURE_KEY]?: true;
}

const globalContainer = globalThis as typeof globalThis & DevelopmentLogCaptureGlobal;

/** Installs the worker-wide capture at process boot; ALS only adds correlation metadata. */
export function ensureWorkerDevelopmentLogOutputCapture(): void {
  if (!canWriteDevelopmentLogs() || globalContainer[WORKER_OUTPUT_CAPTURE_KEY] === true) return;
  globalContainer[WORKER_OUTPUT_CAPTURE_KEY] = true;
  installDevelopmentLogOutputCapture("worker", (event) => {
    void writeDevelopmentLog(event);
  });
}

/** Installs a restorable process-wide stdout, stderr, and sandbox output observer. */
export function installDevelopmentLogOutputCapture(
  processName: "parent" | "worker",
  write: (event: DevelopmentLogEvent) => void,
): () => void {
  const restoreStdout = wrapOutputStream(process.stdout, "stdout", processName, write);
  const restoreStderr = wrapOutputStream(process.stderr, "stderr", processName, write);
  const stopSandboxCapture = listenToSandboxOutput((event) => {
    write({
      at: new Date().toISOString(),
      sandboxId: event.sandboxId,
      sessionId: readActiveSessionId(),
      stream: event.stream,
      text: event.text,
      type: "sandbox.output",
    });
  });
  return () => {
    stopSandboxCapture();
    restoreStderr();
    restoreStdout();
  };
}

function wrapOutputStream(
  stream: WriteStream,
  streamName: "stderr" | "stdout",
  processName: "parent" | "worker",
  write: (event: DevelopmentLogEvent) => void,
): () => void {
  const originalWrite = stream.write;
  const wrappedWrite = function (
    this: WriteStream,
    chunk: string | Uint8Array,
    ...args: readonly unknown[]
  ): boolean {
    const encoding = typeof args[0] === "string" ? args[0] : undefined;
    write({
      at: new Date().toISOString(),
      process: processName,
      sessionId: readActiveSessionId(),
      stream: streamName,
      text: decodeOutputChunk(chunk, encoding),
      type: "process.output",
    });
    return Reflect.apply(originalWrite, this, [chunk, ...args]) as boolean;
  };

  stream.write = wrappedWrite as typeof stream.write;
  return () => {
    if (stream.write === wrappedWrite) {
      stream.write = originalWrite;
    }
  };
}

function readActiveSessionId(): string | undefined {
  return contextStorage.getStore()?.get(DevelopmentLogSessionIdKey);
}

function decodeOutputChunk(chunk: string | Uint8Array, encoding: string | undefined): string {
  if (typeof chunk === "string") return chunk;
  return Buffer.from(chunk).toString(isBufferEncoding(encoding) ? encoding : "utf8");
}

function isBufferEncoding(value: string | undefined): value is BufferEncoding {
  return value !== undefined && Buffer.isEncoding(value);
}
