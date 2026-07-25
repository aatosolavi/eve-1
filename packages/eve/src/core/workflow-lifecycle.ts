import type { ToolSet, TypedToolCall } from "ai";

import { createRuntimeToolResultFromValue } from "#core/action-result-helpers.js";
import type { HarnessEmissionState } from "#core/emission.js";
import { createRuntimeActionRequestFromToolCall } from "#core/runtime-actions.js";
import type { HarnessToolMap } from "#core/step-types.js";
import type { StepLog } from "#core/step-services.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  type HandleMessageStreamEvent,
} from "#core/protocol/message.js";
import { toErrorMessage } from "#core/shared/errors.js";
import type { WorkflowSandboxLifecycle } from "#core/workflow-sandbox-module.js";

type EmitWorkflowLifecycleEvent = (event: HandleMessageStreamEvent) => Promise<void>;

/** Projects sandboxed subagent calls onto eve's existing action event stream. */
export function createWorkflowLifecycle(input: {
  readonly emit: EmitWorkflowLifecycleEvent;
  readonly emissionState: HarnessEmissionState;
  readonly log: Pick<StepLog, "warn">;
  readonly skipReplayed?: boolean;
  readonly tools: HarnessToolMap;
}): WorkflowSandboxLifecycle {
  return {
    onHookError(error, event) {
      input.log.warn("workflow lifecycle hook failed", {
        error,
        hook: event.hook,
      });
    },
    async onNestedToolCall(event) {
      if (input.skipReplayed === true && event.replayed) return;

      const toolCall = {
        input: event.input,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        type: "tool-call",
      } as TypedToolCall<ToolSet>;

      await input.emit(
        createActionsRequestedEvent({
          actions: [createRuntimeActionRequestFromToolCall({ toolCall, tools: input.tools })],
          sequence: input.emissionState.sequence,
          stepIndex: input.emissionState.stepIndex,
          turnId: input.emissionState.turnId,
        }),
      );
    },
    async onNestedToolResult(event) {
      if (input.skipReplayed === true && event.replayed) return;
      if (event.status === "interrupted") return;

      const result = createRuntimeToolResultFromValue({
        callId: event.toolCallId,
        output: event.status === "rejected" ? toErrorMessage(event.error) : event.output,
        toolName: event.toolName,
        isError: event.status === "rejected",
      });

      await input.emit(
        createActionResultEvent({
          result,
          sequence: input.emissionState.sequence,
          stepIndex: input.emissionState.stepIndex,
          turnId: input.emissionState.turnId,
        }),
      );
    },
  };
}
