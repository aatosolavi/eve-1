import type { Telemetry } from "ai";

import { createAiSdkHookBridge } from "#harness/ai-sdk-hook-bridge.js";
import {
  InstrumentationLifecyclePublisher,
  type InstrumentationAttemptScope,
  type InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";

const LOCAL_RUNTIME_KEY = Symbol.for("eve.local-dev-instrumentation-runtime");

export interface LocalDevInstrumentationRuntime {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  createBridge(scope: InstrumentationAttemptScope): Telemetry;
}

interface LocalRuntimeGlobal {
  [LOCAL_RUNTIME_KEY]?: LocalDevInstrumentationRuntime;
}

const globalContainer = globalThis as typeof globalThis & LocalRuntimeGlobal;

export function registerLocalDevInstrumentationRuntime(input: {
  readonly providers: readonly InstrumentationProviderDefinition[];
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}): LocalDevInstrumentationRuntime {
  const publisher = new InstrumentationLifecyclePublisher(input.providers);
  const runtime: LocalDevInstrumentationRuntime = {
    recordInputs: input.recordInputs,
    recordOutputs: input.recordOutputs,
    createBridge: (scope) => createAiSdkHookBridge(scope, publisher),
  };
  globalContainer[LOCAL_RUNTIME_KEY] = runtime;
  return runtime;
}

export function getLocalDevInstrumentationRuntime(): LocalDevInstrumentationRuntime | undefined {
  return globalContainer[LOCAL_RUNTIME_KEY];
}

export function resetLocalDevInstrumentationRuntimeForTesting(): void {
  delete globalContainer[LOCAL_RUNTIME_KEY];
}
