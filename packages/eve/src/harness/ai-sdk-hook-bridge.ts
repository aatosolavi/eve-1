import type { Telemetry } from "ai";

import type {
  InstrumentationAttemptScope,
  InstrumentationLifecyclePublisher,
} from "#harness/instrumentation-lifecycle.js";

type TelemetryEvent<TKey extends keyof Telemetry> = Parameters<NonNullable<Telemetry[TKey]>>[0];

/** Creates one provider-neutral AI SDK bridge for one actual model attempt. */
export function createAiSdkHookBridge(
  scope: InstrumentationAttemptScope,
  publisher: InstrumentationLifecyclePublisher,
): Telemetry {
  let operationStart: TelemetryEvent<"onStart"> | undefined;
  let stepEnd: TelemetryEvent<"onStepEnd"> | undefined;
  const modelIds = new Map<string, string>();
  const toolIds = new Map<string, string>();

  return {
    onStart(event) {
      operationStart = event;
    },
    async onStepStart(event) {
      if (operationStart === undefined) return;
      await publisher.publishStepStarted({ operation: operationStart, scope, step: event });
    },
    async onLanguageModelCallStart(event) {
      const id = `${scope.attemptId}:model:${event.callId}`;
      modelIds.set(event.callId, id);
      await publisher.beforeModelCall({ id, scope, source: event });
    },
    executeLanguageModelCall({ callId, execute }) {
      return publisher.runModelCall(
        modelIds.get(callId) ?? `${scope.attemptId}:model:${callId}`,
        execute,
      );
    },
    async onLanguageModelCallEnd(event) {
      const id = modelIds.get(event.callId) ?? `${scope.attemptId}:model:${event.callId}`;
      modelIds.delete(event.callId);
      await publisher.afterModelCall({ id, scope, source: event });
    },
    async onToolExecutionStart(event) {
      const id = `${scope.attemptId}:tool:${event.toolCall.toolCallId}`;
      toolIds.set(event.toolCall.toolCallId, id);
      await publisher.beforeToolCall({ id, scope, source: event });
    },
    executeTool({ toolCallId, execute }) {
      return publisher.runToolCall(
        toolIds.get(toolCallId) ?? `${scope.attemptId}:tool:${toolCallId}`,
        execute,
      );
    },
    async onToolExecutionEnd(event) {
      const toolCallId = event.toolCall.toolCallId;
      const id = toolIds.get(toolCallId) ?? `${scope.attemptId}:tool:${toolCallId}`;
      toolIds.delete(toolCallId);
      await publisher.afterToolCall({ id, scope, source: event });
    },
    onStepEnd(event) {
      stepEnd = event;
    },
    async onEnd(event) {
      if (operationStart === undefined) return;
      await publisher.publishStepCompleted({
        operation: operationStart,
        result: event,
        scope,
        step: stepEnd,
      });
    },
    async onAbort(event) {
      await publisher.publishStepFailed({ error: event, scope });
    },
    async onError(error) {
      await publisher.publishStepFailed({ error, scope });
    },
  };
}
