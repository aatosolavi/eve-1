import type { LocalRuntimeServerGroup } from "./local-servers.js";

export type BenchmarkSignal = "SIGINT" | "SIGTERM";

export interface BenchmarkSignalHost {
  exit(code: number): void;
  off(signal: BenchmarkSignal, listener: () => void): void;
  once(signal: BenchmarkSignal, listener: () => void): void;
}

export interface StoppableBenchmarkServerGroup {
  stop(): Promise<void>;
}

export function installBenchmarkServerSignalCleanup(input: {
  readonly cleanupFailureLabel: string;
  readonly cleanupLabel: string;
  readonly host: BenchmarkSignalHost;
  readonly serverGroup: StoppableBenchmarkServerGroup;
  readonly writeDiagnostic: (message: string) => void;
}): () => void {
  let handlingSignal = false;

  const remove = () => {
    input.host.off("SIGINT", onInterrupt);
    input.host.off("SIGTERM", onTerminate);
  };
  const handle = (signal: BenchmarkSignal, exitCode: number) => {
    if (handlingSignal) return;
    handlingSignal = true;
    remove();
    input.writeDiagnostic(`Received ${signal}. Stopping ${input.cleanupLabel}.\n`);
    void input.serverGroup
      .stop()
      .catch((error: unknown) => {
        input.writeDiagnostic(
          `${input.cleanupFailureLabel} cleanup failed: ${formatError(error)}\n`,
        );
      })
      .finally(() => input.host.exit(exitCode));
  };
  function onInterrupt() {
    handle("SIGINT", 130);
  }
  function onTerminate() {
    handle("SIGTERM", 143);
  }

  input.host.once("SIGINT", onInterrupt);
  input.host.once("SIGTERM", onTerminate);
  return remove;
}

export function installLocalServerSignalCleanup(input: {
  readonly host: BenchmarkSignalHost;
  readonly serverGroup: LocalRuntimeServerGroup;
  readonly writeDiagnostic: (message: string) => void;
}): () => void {
  return installBenchmarkServerSignalCleanup({
    cleanupFailureLabel: "Local server",
    cleanupLabel: "local benchmark servers",
    ...input,
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
