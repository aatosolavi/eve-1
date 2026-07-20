import { describe, expect, it, vi } from "vitest";

import { LocalRuntimeServerHost, type LocalRuntimeServerProcess } from "./local-servers.js";
import {
  installLocalServerSignalCleanup,
  type BenchmarkSignal,
  type BenchmarkSignalHost,
} from "./signals.js";

describe("installLocalServerSignalCleanup", () => {
  it("stops the active local server before exiting on SIGINT", async () => {
    const signal = createSignalTestHost();
    const stop = vi.fn(async () => undefined);
    const serverHost = new LocalRuntimeServerHost(() =>
      fakeProcess(Promise.resolve("http://workflow.example"), stop),
    );
    await serverHost.acquire("workflow", "deterministic");
    const writeDiagnostic = vi.fn();
    installLocalServerSignalCleanup({
      host: signal.host,
      serverHost,
      writeDiagnostic,
    });

    signal.listeners.get("SIGINT")?.();

    await expect(signal.exited).resolves.toBe(130);
    expect(stop).toHaveBeenCalledOnce();
    expect(signal.listeners.size).toBe(0);
    expect(writeDiagnostic).toHaveBeenCalledWith(
      "Received SIGINT. Stopping the active local benchmark server.\n",
    );
  });

  it("stops a local server that is still becoming ready before exiting on SIGTERM", async () => {
    const signal = createSignalTestHost();
    const readiness = Promise.withResolvers<string>();
    const stop = vi.fn(async () => {
      readiness.reject(new Error("stopped during startup"));
    });
    const serverHost = new LocalRuntimeServerHost(() => fakeProcess(readiness.promise, stop));
    const acquisition = serverHost.acquire("workflow", "live");
    const acquisitionStopped = expect(acquisition).rejects.toThrow("stopped during startup");
    installLocalServerSignalCleanup({
      host: signal.host,
      serverHost,
      writeDiagnostic: vi.fn(),
    });

    signal.listeners.get("SIGTERM")?.();

    await acquisitionStopped;
    await expect(signal.exited).resolves.toBe(143);
    expect(stop).toHaveBeenCalledOnce();
    expect(signal.listeners.size).toBe(0);
  });
});

function createSignalTestHost(): {
  readonly exited: Promise<number>;
  readonly host: BenchmarkSignalHost;
  readonly listeners: Map<BenchmarkSignal, () => void>;
} {
  const listeners = new Map<BenchmarkSignal, () => void>();
  const exit = Promise.withResolvers<number>();
  return {
    exited: exit.promise,
    host: {
      exit: exit.resolve,
      off(signal) {
        listeners.delete(signal);
      },
      once(signal, listener) {
        listeners.set(signal, listener);
      },
    },
    listeners,
  };
}

function fakeProcess(url: Promise<string>, stop: () => Promise<void>): LocalRuntimeServerProcess {
  return {
    async readRecordFile() {
      return undefined;
    },
    async stop() {
      await stop();
    },
    url,
  };
}
