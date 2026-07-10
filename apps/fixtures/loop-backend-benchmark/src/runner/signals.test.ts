import { describe, expect, it, vi } from "vitest";

import { LocalRuntimeServerGroup } from "./local-servers.js";
import {
  installLocalServerSignalCleanup,
  type BenchmarkSignal,
  type BenchmarkSignalHost,
} from "./signals.js";

describe("installLocalServerSignalCleanup", () => {
  it("stops local servers before exiting on SIGINT", async () => {
    const listeners = new Map<BenchmarkSignal, () => void>();
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const stop = vi.fn(async (_runtimeKind: string) => undefined);
    const serverGroup = new LocalRuntimeServerGroup((runtimeKind) => ({
      async readRecordFile() {
        return undefined;
      },
      async stop() {
        await stop(runtimeKind);
      },
      url: Promise.resolve(`http://${runtimeKind}.example`),
    }));
    await serverGroup.start("deterministic");
    const host: BenchmarkSignalHost = {
      exit(code) {
        resolveExit?.(code);
      },
      off(signal) {
        listeners.delete(signal);
      },
      once(signal, listener) {
        listeners.set(signal, listener);
      },
    };
    installLocalServerSignalCleanup({
      host,
      serverGroup,
      writeDiagnostic: vi.fn(),
    });

    listeners.get("SIGINT")?.();
    await expect(exited).resolves.toBe(130);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(listeners.size).toBe(0);
  });
});
