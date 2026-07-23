import type { Span } from "#compiled/@opentelemetry/api/index.js";
import type { LanguageModel, ModelMessage, SystemModelMessage } from "ai";
import type { AlsContext } from "#context/container.js";
import type { StepFlowTypes } from "#core/turn-before-call.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { RejectedActionBatch } from "#harness/input-requests.js";
import type { ModelCallRunner, PreparedModelCallInput } from "#harness/model-call.js";
import type { AnthropicCacheMarker, PromptCachePath } from "#harness/prompt-cache.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import type { GenerateOutcome, HarnessSession, StepInput } from "#harness/types.js";

/**
 * The harness binding of the core step flow
 * ({@link import("#core/turn-call.js").generateStep}): the concrete types
 * behind every opaque {@link StepFlowTypes} slot. The ports themselves are
 * bound in `turn-before-call.ts` (pre-call) and `turn-call.ts` (call and
 * after-call).
 */
export interface HarnessStepFlow extends StepFlowTypes {
  readonly callResult: HarnessStepResult;
  readonly callRunner: HarnessCallRunner;
  readonly emissionState: HarnessEmissionState;
  readonly history: ModelMessage[];
  readonly limitGrant: { readonly granted: boolean };
  readonly modelEnvironment: ModelCallEnvironment;
  readonly outcome: GenerateOutcome;
  readonly prompt: PreparedModelCall;
  readonly rejectedApprovals: RejectedActionBatch;
  readonly state: HarnessSession;
  readonly stepInput: StepInput;
  readonly turnTrace: Span;
}

/**
 * The step's shared turn-span slot. The trace ports open the span mid-step,
 * after the flow ports were constructed, so the flow ports read it through
 * this cell instead of capturing a value.
 */
export interface TurnSpanCell {
  current: Span | undefined;
}

/** The resolved model call environment threaded through assembly. */
export interface ModelCallEnvironment {
  readonly attributionHeaders: Record<string, string> | undefined;
  readonly cachePath: PromptCachePath;
  /** Ambient context, absent in direct harness unit tests. */
  readonly ctx: AlsContext | undefined;
  readonly marker: AnthropicCacheMarker | undefined;
  readonly model: LanguageModel;
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
 * One step's prepared model call: the runner plus the resolved
 * first-attempt input, the prompt it was built from, and the emission
 * coordinates it reports under.
 */
export interface HarnessCallRunner {
  readonly emissionState: HarnessEmissionState;
  readonly modelCall: ModelCallRunner;
  readonly preparedInput: PreparedModelCallInput;
  readonly prompt: PreparedModelCall;
}
