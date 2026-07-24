import type { HandleMessageStreamEvent } from "#protocol/message.js";

/**
 * Returns true when an error looks like a stream socket disconnection that
 * can be recovered via reconnection.
 */
export function isStreamDisconnectError(error: unknown): boolean {
  if (error instanceof StreamIdleTimeoutError) {
    return true;
  }

  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = "code" in error && typeof error.code === "string" ? error.code : undefined;

  return (
    error.name === "AbortError" ||
    error.message === "terminated" ||
    errorCode === "UND_ERR_SOCKET" ||
    (error instanceof TypeError && /^(?:failed to fetch|fetch failed)$/i.test(error.message)) ||
    /abort|cancel|disconnect|premature close|socket|terminated/i.test(error.message)
  );
}

class StreamIdleTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Message stream produced no bytes for ${timeoutMs}ms.`);
    this.name = "StreamIdleTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Returns true when a stream ended because it stopped delivering bytes rather
 * than because the transport ended.
 *
 * An open stream that goes quiet says nothing about whether the run is still
 * progressing, so callers must not treat it as evidence of an exhausted
 * session the way they treat a connection that ends without events.
 */
export function isStreamIdleTimeoutError(error: unknown): boolean {
  return error instanceof StreamIdleTimeoutError;
}

interface ReadNdjsonStreamOptions {
  readonly idleTimeoutMs?: number;
}

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

/**
 * Reads newline-delimited JSON events from a `ReadableStream<Uint8Array>`.
 *
 * Yields one parsed {@link HandleMessageStreamEvent} per complete NDJSON line.
 * Handles partial lines across chunks via an internal buffer.
 *
 * All read errors — including socket disconnections — propagate to the caller.
 * Use {@link isStreamDisconnectError} to classify them.
 */
export async function* readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  options: ReadNdjsonStreamOptions = {},
): AsyncGenerator<HandleMessageStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;

  try {
    while (true) {
      const result = await readWithIdleTimeout(reader, options.idleTimeoutMs);

      if (result.done) {
        reachedEof = true;
        // Flush any remaining bytes in the decoder.
        buffer += decoder.decode();
        break;
      }

      if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
      }

      // Yield every complete line currently in the buffer.
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          yield JSON.parse(line) as HandleMessageStreamEvent;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    // Yield any trailing content without a final newline.
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      yield JSON.parse(trailing) as HandleMessageStreamEvent;
    }
  } finally {
    if (!reachedEof) {
      // Breaking an async iteration must close the response body; releasing
      // its lock alone leaves the server-side stream open.
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number | undefined,
): Promise<StreamReadResult> {
  if (idleTimeoutMs === undefined) {
    return await reader.read();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new StreamIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
  });

  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
