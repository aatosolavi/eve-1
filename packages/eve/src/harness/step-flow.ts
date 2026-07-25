import type { Span } from "#compiled/@opentelemetry/api/index.js";
import type { LanguageModel, ModelMessage, SystemModelMessage, UserContent } from "ai";
import type { AlsContext } from "#context/container.js";
import type { StepFacets, StepFlowTypes } from "#core/step-ports.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#core/emission.js";
import type { HarnessEmissionState } from "#core/emission.js";
import { hasStepInput } from "#core/input-requests.js";
import type { RejectedActionBatch } from "#core/input-requests.js";
import { normalizeUserContent } from "#core/messages.js";
import type { ModelCallRunner, PreparedModelCallInput } from "#harness/model-call.js";
import type { resolveCompactionModel } from "#harness/compaction.js";
import type { AnthropicCacheMarker, PromptCachePath } from "#core/prompt-cache.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import type { RecoveryRetryCallOptions } from "#harness/model-call-recovery.js";
import type { accumulateTurnUsage } from "#core/turn-tag-state.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import type { RuntimeActionResult } from "#core/actions/types.js";
import type { JsonObject } from "#core/shared/json.js";
import type { TokenUsage } from "#core/shared/token-usage.js";

/**
 * The harness binding of the core step flow
 * ({@link import("#core/turn-call.js").generateStep}): the concrete types
 * behind every opaque {@link StepFlowTypes} slot, plus the facets the
 * flow reads over them. The dependency groups are bound in
 * `step-events.ts`, `turn-before-call.ts`, `turn-call.ts`, and
 * `turn-trace.ts`.
 */
export interface HarnessStepFlow extends StepFlowTypes {
  readonly ambientContext: AlsContext;
  readonly approvalResult: RuntimeActionResult;
  readonly callAttempt: PreparedModelCallInput;
  readonly callResult: HarnessStepResult;
  readonly callRunner: HarnessCallRunner;
  readonly cacheMarker: AnthropicCacheMarker;
  readonly cachePath: PromptCachePath;
  readonly compactionModel: Awaited<ReturnType<typeof resolveCompactionModel>>;
  readonly emissionState: HarnessEmissionState;
  readonly failureContent: HarnessFailureContent;
  readonly historyEntry: ModelMessage;
  readonly limitGrant: { readonly granted: boolean };
  readonly logFields: Record<string, unknown>;
  readonly model: LanguageModel;
  readonly modelHeaders: Record<string, string> | undefined;
  readonly prompt: PreparedModelCall;
  readonly rejectedApprovals: RejectedActionBatch;
  readonly retryOptions: RecoveryRetryCallOptions;
  readonly state: HarnessSession;
  readonly stepInput: StepInput;
  readonly turnTrace: Span;
  readonly usage: TokenUsage;
  readonly usageSnapshot: ReturnType<typeof accumulateTurnUsage>;
  readonly userContent: UserContent;
}

/** Failure content consumed by the failure lifecycle events. */
export interface HarnessFailureContent {
  readonly code: string;
  readonly details: JsonObject;
  readonly message: string;
}

/** The assembled prompt: everything one model call consumes. */
export interface PreparedModelCall {
  readonly approvedTools: ReadonlySet<string>;
  readonly attributionHeaders: Record<string, string> | undefined;
  readonly cachePath: PromptCachePath;
  /** Ambient context, absent in direct harness unit tests. */
  readonly ctx: AlsContext | undefined;
  readonly emptyDeliveryEnabled: boolean;
  readonly marker: AnthropicCacheMarker | undefined;
  /**
   * The durable prompt: ref-only attachment parts, flows into
   * `session.history` after the step. Never carries raw bytes.
   */
  readonly messages: ModelMessage[];
  readonly model: LanguageModel;
  /**
   * Transient projection of `messages` for the model call: attachments
   * hydrated to inline bytes, system entries split out.
   */
  readonly modelMessages: ModelMessage[];
  readonly session: HarnessSession;
  readonly systemMessages: SystemModelMessage[];
}

/**
 * One step's model-call runner with the prompt it was built from and the
 * emission coordinates it reports under.
 */
export interface HarnessCallRunner {
  readonly emissionState: HarnessEmissionState;
  readonly modelCall: ModelCallRunner;
  readonly prompt: PreparedModelCall;
}

/** Binds the core facets to the harness payloads. */
export function createStepFacets(): StepFacets<HarnessStepFlow> {
  return {
    approvalResultsOf: (batch) => batch.results,
    contextEntriesOf: (input) => input?.context,
    deliveryContentOf: (input) => normalizeUserContent(input?.message),
    hasDelivery: (input) => hasStepInput(input),
    hasOutputSchema: (state) => state.outputSchema !== undefined,
    readEmission: (state) => getHarnessEmissionState(state.state),
    sessionIdOf: (state) => state.sessionId,
    turnIdOf: (emissionState) => emissionState.turnId,
    writeEmission: (state, emissionState) => setHarnessEmissionState(state, emissionState),
  };
}
