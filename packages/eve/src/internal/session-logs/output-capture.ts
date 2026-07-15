import type { WriteStream } from "node:tty";

import { listenToSandboxOutput } from "#execution/sandbox/output-events.js";
import {
  canWriteDevelopmentSessionLogs,
  readActiveSessionLogId,
  writeDevelopmentSessionLog,
} from "#internal/session-logs/client.js";

const SESSION_OUTPUT_CAPTURE_KEY = Symbol.for("eve.development-session-output-capture");

interface SessionOutputCaptureGlobal {
  [SESSION_OUTPUT_CAPTURE_KEY]?: true;
}

const globalContainer = globalThis as typeof globalThis & SessionOutputCaptureGlobal;

/** Installs one process-wide stdout/stderr tee; ALS supplies per-write session ownership. */
export function ensureDevelopmentSessionOutputCapture(): void {
  if (!canWriteDevelopmentSessionLogs() || globalContainer[SESSION_OUTPUT_CAPTURE_KEY] === true) {
    return;
  }

  globalContainer[SESSION_OUTPUT_CAPTURE_KEY] = true;
  wrapOutputStream(process.stdout, "stdout");
  wrapOutputStream(process.stderr, "stderr");
  listenToSandboxOutput((event) => {
    const sessionId = readActiveSessionLogId();
    if (sessionId === undefined) return;
    void writeDevelopmentSessionLog({
      at: new Date().toISOString(),
      sandboxId: event.sandboxId,
      sessionId,
      stream: event.stream,
      text: event.text,
      type: "sandbox.output",
    });
  });
}

function wrapOutputStream(stream: WriteStream, streamName: "stderr" | "stdout"): void {
  const originalWrite = stream.write;
  const wrappedWrite = function (
    this: WriteStream,
    chunk: string | Uint8Array,
    ...args: readonly unknown[]
  ): boolean {
    const sessionId = readActiveSessionLogId();
    if (sessionId !== undefined) {
      const encoding = typeof args[0] === "string" ? args[0] : undefined;
      void writeDevelopmentSessionLog({
        at: new Date().toISOString(),
        sessionId,
        stream: streamName,
        text: decodeOutputChunk(chunk, encoding),
        type: "process.output",
      });
    }
    return Reflect.apply(originalWrite, this, [chunk, ...args]) as boolean;
  };

  // Node's write method has several callback/encoding overloads. The wrapper
  // preserves those arguments verbatim and changes only the observation side effect.
  stream.write = wrappedWrite as typeof stream.write;
}

function decodeOutputChunk(chunk: string | Uint8Array, encoding: string | undefined): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return Buffer.from(chunk).toString(isBufferEncoding(encoding) ? encoding : "utf8");
}

function isBufferEncoding(value: string | undefined): value is BufferEncoding {
  return value !== undefined && Buffer.isEncoding(value);
}
