const LOCAL_DEV_TRACING_MODE_KEY = Symbol.for("eve.local-dev-tracing-mode");

interface LocalDevTracingModeGlobal {
  [LOCAL_DEV_TRACING_MODE_KEY]?: boolean;
}

const globalContainer = globalThis as typeof globalThis & LocalDevTracingModeGlobal;

/** Marks this process as using eve-owned local dev tracing. */
export function enableLocalDevTracingMode(): void {
  globalContainer[LOCAL_DEV_TRACING_MODE_KEY] = true;
}

/** Whether the process is using eve-owned local dev tracing. */
export function isLocalDevTracingEnabled(): boolean {
  return globalContainer[LOCAL_DEV_TRACING_MODE_KEY] === true;
}

/** Clears local tracing mode. Test-only. */
export function disableLocalDevTracingModeForTesting(): void {
  delete globalContainer[LOCAL_DEV_TRACING_MODE_KEY];
}
