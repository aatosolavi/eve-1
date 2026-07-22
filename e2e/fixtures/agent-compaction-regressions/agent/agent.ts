import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

import {
  COMPACTION_CHECKPOINT_TEXT,
  READ_BACK_MARKER,
  OVERSIZED_PAYLOAD_TAIL_SENTINEL,
  OVERSIZED_TRUNCATION_MARKER,
  SECOND_CHECKPOINT_MARKER,
  TASK_PRESERVED_MARKER,
  TASK_TAIL_SENTINEL,
  TRUNCATION_ANNOTATION_PREFIX,
} from "../constants";

const TEST_CONTEXT_WINDOW_TOKENS = 32_000;
const MAX_TOOL_CALLS = 10;

type RegressionCase =
  | "redundant-tool-calls"
  | "stale-todo-work"
  | "task-survival"
  | "oversized-step-truncation"
  | "read-truncated-result";

/** Per-case call bookkeeping shared by every responder. */
interface CaseState {
  advanceCalls: number;
  toolCalls: number;
}

type CaseResponder = (request: MockModelRequest, state: CaseState) => MockModelResponse | string;

/**
 * One responder per regression case. Adding a case means adding an entry
 * here (plus its marker in {@link regressionCaseFromText}) — the dispatch
 * and bookkeeping never change.
 */
const responders: Record<RegressionCase, CaseResponder> = {
  "redundant-tool-calls": markerWorkCase(
    "redundant-tool-calls",
    "REPOSITORY_INSPECTION_COMPLETE",
    (attempt) => ({
      id: `inspect-repository-${attempt}`,
      input: { scope: "repository" },
      name: "inspect-repository",
    }),
  ),

  "stale-todo-work": markerWorkCase("stale-todo-work", "SOURCE_ANALYSIS_COMPLETE", (attempt) => ({
    id: `perform-source-analysis-${attempt}`,
    input: { approach: `attempt-${attempt}` },
    name: "perform-source-analysis",
  })),

  "task-survival": (request, state) => {
    const compacted = request.messages.some(
      (message) => message.role === "user" && message.text === COMPACTION_CHECKPOINT_TEXT,
    );
    if (compacted) {
      // The harness must hand the model its verbatim task back after
      // compaction — via the kept tail or the resumption replay. Losing it
      // is the trace failure this case pins.
      return request.userMessages.some((text) => text.includes(TASK_TAIL_SENTINEL))
        ? `Task text still visible: ${TASK_PRESERVED_MARKER}`
        : "Task text lost after compaction: TASK_LOST";
    }

    if (state.toolCalls >= MAX_TOOL_CALLS) {
      return "Hard stop without a compaction: TASK_SURVIVAL_NO_COMPACTION";
    }

    state.toolCalls += 1;
    return {
      toolCalls: [
        {
          id: `inspect-repository-${state.toolCalls}`,
          input: { scope: "repository" },
          name: "inspect-repository",
        },
      ],
    };
  },

  "read-truncated-result": (request, state) => {
    // Success: a read-back page reached the tail sentinel that every
    // truncation cut. The round trip through the session stream worked.
    if (
      request.messages.some(
        (message) =>
          message.role !== "user" && message.text.includes(OVERSIZED_PAYLOAD_TAIL_SENTINEL),
      )
    ) {
      return `Read back truncated output: ${READ_BACK_MARKER}`;
    }

    // Walk the pagination contract: each page's nextOffsetChars feeds the
    // next call until the sentinel (at the very end of the payload) appears.
    const callId = request.messages
      .map(
        (message) => /read_tool_result tool: \{"toolCallId": "([^"]+)"\}/.exec(message.text)?.[1],
      )
      .find((id) => id !== undefined);
    if (callId !== undefined) {
      if (state.advanceCalls >= MAX_TOOL_CALLS) {
        return `Hard stop after ${MAX_TOOL_CALLS} read-backs: READ_BACK_TAIL_MISSING`;
      }

      const nextOffsets = request.messages
        .map((message) => /"nextOffsetChars":\s*(\d+)/.exec(message.text)?.[1])
        .filter((offset) => offset !== undefined);
      const offsetChars = nextOffsets.length === 0 ? 0 : Number(nextOffsets.at(-1));

      state.advanceCalls += 1;
      return {
        toolCalls: [
          {
            id: `read-tool-result-${state.advanceCalls}`,
            // Pages stay under the fixture's per-step budget so page bodies
            // (and their nextOffsetChars) reach the model untruncated.
            input: { limitChars: 6_000, offsetChars, toolCallId: callId },
            name: "read_tool_result",
          },
        ],
      };
    }

    if (state.toolCalls >= MAX_TOOL_CALLS) {
      return `Hard stop after ${MAX_TOOL_CALLS} calls: TRUNCATION_ANNOTATION_MISSING`;
    }

    state.toolCalls += 1;
    return {
      toolCalls: [
        {
          id: `emit-oversized-output-${state.toolCalls}`,
          input: {},
          name: "emit-oversized-output",
        },
      ],
    };
  },

  "oversized-step-truncation": (request, state) => {
    // The harness truncates the oversized result at attach time, so the
    // annotation must be visible in the request — whether the result is
    // still verbatim in recent history or reduced during compaction —
    // before the model reports success.
    if (request.messages.some((message) => message.text.includes(TRUNCATION_ANNOTATION_PREFIX))) {
      return `Observed harness truncation: ${OVERSIZED_TRUNCATION_MARKER}`;
    }

    if (state.toolCalls >= MAX_TOOL_CALLS) {
      return `Hard stop after ${MAX_TOOL_CALLS} calls: TRUNCATION_ANNOTATION_MISSING`;
    }

    state.toolCalls += 1;
    return {
      toolCalls: [
        {
          id: `emit-oversized-output-${state.toolCalls}`,
          input: {},
          name: "emit-oversized-output",
        },
      ],
    };
  },
};

/**
 * The shared protocol of the two marker-driven work cases: run the work tool
 * until its completion marker is visible, then run the second-compaction
 * trigger tool, then finish. Completion evidence is detected in any assistant
 * message: compaction may leave it as a summarization checkpoint or as a
 * capped result, and the model must not repeat work in either case. User
 * messages are excluded because the eval instructions quote the markers.
 */
function markerWorkCase(
  regressionCase: "redundant-tool-calls" | "stale-todo-work",
  marker: string,
  workToolCall: (attempt: number) => { id: string; input: object; name: string },
): CaseResponder {
  return (request, state) => {
    if (assistantEvidenceContains(request.messages, marker)) {
      if (assistantEvidenceContains(request.messages, SECOND_CHECKPOINT_MARKER)) {
        return `Done: ${marker}; ${SECOND_CHECKPOINT_MARKER}`;
      }

      if (state.advanceCalls >= MAX_TOOL_CALLS) {
        return `Hard stop after ${MAX_TOOL_CALLS} checkpoint advances: ${marker}`;
      }

      state.advanceCalls += 1;
      return {
        toolCalls: [
          {
            id: `advance-checkpoint-${state.advanceCalls}`,
            input: { regressionCase },
            name: "advance-checkpoint",
          },
        ],
      };
    }

    if (state.toolCalls >= MAX_TOOL_CALLS) {
      return `Hard stop after ${MAX_TOOL_CALLS} calls: ${marker}`;
    }

    state.toolCalls += 1;
    return { toolCalls: [workToolCall(state.toolCalls)] };
  };
}

let activeCase: RegressionCase | undefined;
const caseStates = new Map<RegressionCase, CaseState>();
let requestCount = 0;

const taskModel = mockModel({
  modelId: "compaction-regression-task-model",
  respond(request) {
    dumpContextWhenEnabled(request);

    const initialCase = findInitialCase(request);
    if (initialCase !== undefined && activeCase !== initialCase) {
      activeCase = initialCase;
      caseStates.set(initialCase, { advanceCalls: 0, toolCalls: 0 });
    }

    if (activeCase === undefined) {
      throw new Error("Compaction regression task model received no case marker.");
    }

    const state = caseStates.get(activeCase);
    if (state === undefined) {
      throw new Error(`Compaction regression task model has no state for ${activeCase}.`);
    }

    return responders[activeCase](request, state);
  },
});

export default defineAgent({
  model: taskModel,
  modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
  compaction: {
    model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
    modelContextWindowTokens: TEST_CONTEXT_WINDOW_TOKENS,
    thresholdPercent: 0.02,
  },
  limits: {
    maxInputTokensPerSession: 100_000,
  },
});

// EVE_E2E_DUMP_CONTEXT=1 prints every request's messages — the context
// exactly as the model sees it, so compaction, capping, and replay are
// observable per step while iterating on these evals.
function dumpContextWhenEnabled(request: MockModelRequest): void {
  if (!process.env.EVE_E2E_DUMP_CONTEXT) {
    return;
  }
  requestCount += 1;
  console.log(`\n=== model request #${requestCount} (${request.messages.length} messages) ===`);
  for (const message of request.messages) {
    const text = message.text.replace(/\s+/g, " ");
    console.log(`  [${message.role}] ${text.length} chars | ${text.slice(0, 160)}`);
  }
}

function findInitialCase(request: MockModelRequest): RegressionCase | undefined {
  for (const message of request.userMessages) {
    const regressionCase = regressionCaseFromText(message);
    if (regressionCase !== undefined) return regressionCase;
  }

  return undefined;
}

function regressionCaseFromText(text: string): RegressionCase | undefined {
  if (text.includes("[case: redundant-tool-calls]")) return "redundant-tool-calls";
  if (text.includes("[case: stale-todo-work]")) return "stale-todo-work";
  if (text.includes("[case: task-survival]")) return "task-survival";
  if (text.includes("[case: oversized-step-truncation]")) return "oversized-step-truncation";
  if (text.includes("[case: read-truncated-result]")) return "read-truncated-result";
  return undefined;
}

function assistantEvidenceContains(
  messages: MockModelRequest["messages"],
  marker: string,
): boolean {
  return messages.some((message) => message.role === "assistant" && message.text.includes(marker));
}
