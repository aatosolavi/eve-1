export interface SandboxOutputEvent {
  readonly sandboxId: string;
  readonly stream: "stderr" | "stdout";
  readonly text: string;
}

type SandboxOutputListener = (event: SandboxOutputEvent) => void;

const listeners = new Set<SandboxOutputListener>();

/** Subscribes to output produced by eve-owned sandbox process streams. */
export function listenToSandboxOutput(listener: SandboxOutputListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitSandboxOutput(event: SandboxOutputEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Diagnostics must not alter the sandbox process being observed.
    }
  }
}

export function createSandboxOutputObserver(sandboxId: string): {
  close(stream: "stderr" | "stdout"): void;
  write(stream: "stderr" | "stdout", chunk: string | Uint8Array): void;
} {
  const decoders = {
    stderr: new TextDecoder(),
    stdout: new TextDecoder(),
  };

  return {
    close(stream) {
      emit(stream, decoders[stream].decode());
    },
    write(stream, chunk) {
      const text =
        typeof chunk === "string" ? chunk : decoders[stream].decode(chunk, { stream: true });
      emit(stream, text);
    },
  };

  function emit(stream: "stderr" | "stdout", text: string): void {
    if (text.length > 0) {
      emitSandboxOutput({ sandboxId, stream, text });
    }
  }
}
