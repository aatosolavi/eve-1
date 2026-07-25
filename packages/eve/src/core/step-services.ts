import type { Span } from "#compiled/@opentelemetry/api/index.js";
import type { LanguageModel, ModelMessage, SystemModelMessage, UserContent } from "ai";

import type { AlsContext } from "#context/container.js";
import type { HarnessEmissionState } from "#core/emission.js";
import type { JsonObject } from "#core/shared/json.js";
import type { TurnUsageState } from "#core/turn-tag-state.js";
import type { HarnessStepResult } from "#core/step-hooks.js";
import type { resolveCompactionModel } from "#core/compaction.js";
import type { ModelCallRunner, PreparedModelCallInput } from "#harness/model-call.js";
import type { RecoveryRetryCallOptions } from "#core/model-call-recovery.js";
import type { GenerateOutcome, HarnessSession, StepInput } from "#core/step-types.js";
import type { AnthropicCacheMarker, PromptCachePath } from "#core/prompt-cache.js";

/** Failure content emitted by the step flow. */
export interface StepFailureContent {
  readonly code: string;
  readonly details: JsonObject;
  readonly message: string;
}

/** Everything one model call consumes after prompt assembly. */
export interface PreparedModelCall {
  readonly approvedTools: ReadonlySet<string>;
  readonly attributionHeaders: Record<string, string> | undefined;
  readonly cachePath: PromptCachePath;
  readonly ctx: AlsContext | undefined;
  readonly emptyDeliveryEnabled: boolean;
  readonly marker: AnthropicCacheMarker | undefined;
  /**
   * Durable history contains attachment references, never hydrated bytes.
   */
  readonly messages: ModelMessage[];
  readonly model: LanguageModel;
  /**
   * Model-facing messages hydrate attachments and exclude system entries.
   */
  readonly modelMessages: ModelMessage[];
  readonly session: HarnessSession;
  readonly systemMessages: SystemModelMessage[];
}

/** A model-call runner paired with the prompt and emission identity it serves. */
export interface StepCallRunner {
  readonly emissionState: HarnessEmissionState;
  readonly modelCall: ModelCallRunner;
  readonly prompt: PreparedModelCall;
}

export type CompactionModel = Awaited<ReturnType<typeof resolveCompactionModel>>;

export type RecoveryStage = (input: {
  readonly error: unknown;
  readonly retryOptions: RecoveryRetryCallOptions | undefined;
  readonly runner: StepCallRunner;
}) => Promise<
  | { readonly outcome: "recovered"; readonly result: HarnessStepResult }
  | {
      readonly outcome: "failed";
      readonly error: unknown;
      readonly retryOptions?: RecoveryRetryCallOptions;
    }
  | { readonly outcome: "skipped" }
>;

export interface ModelCallServices {
  attributionHeaders(model: LanguageModel): Record<string, string> | undefined;
  compact(input: {
    readonly compactionModel: CompactionModel;
    readonly history: readonly ModelMessage[];
    readonly state: HarnessSession;
  }): Promise<readonly ModelMessage[]>;
  continueWorkflowInterrupt(input: {
    readonly emissionState: HarnessEmissionState;
    readonly input: StepInput | undefined;
    readonly prompt: PreparedModelCall;
  }): Promise<GenerateOutcome | null>;
  create(input: {
    readonly emissionState: HarnessEmissionState;
    readonly prompt: PreparedModelCall;
  }): ModelCallRunner;
  currentState(runner: ModelCallRunner): HarnessSession;
  readonly dispatchDynamicModel?: (input: {
    readonly ctx: AlsContext;
    readonly emissionState: HarnessEmissionState;
    readonly history: readonly ModelMessage[];
    readonly state: HarnessSession;
  }) => Promise<void>;
  formatModelId(model: LanguageModel): string;
  prepareAttempt(runner: ModelCallRunner): PreparedModelCallInput;
  readonly recoveryStages: readonly RecoveryStage[];
  resolveActive(input: {
    readonly ctx: AlsContext | undefined;
    readonly state: HarnessSession;
  }): Promise<{ readonly model: LanguageModel; readonly state: HarnessSession }>;
  resolveCompaction(input: {
    readonly model: LanguageModel;
    readonly state: HarnessSession;
  }): Promise<CompactionModel>;
  run(input: {
    readonly attempt: PreparedModelCallInput;
    readonly runner: ModelCallRunner;
  }): Promise<HarnessStepResult>;
}

export interface AttachmentServices {
  hydrate(history: readonly ModelMessage[]): Promise<readonly ModelMessage[]>;
  stage(content: UserContent): Promise<UserContent>;
}

export interface AmbientServices {
  current(): AlsContext | undefined;
  dynamicInstructionEntries(ctx: AlsContext): readonly SystemModelMessage[];
  hasParentSession(ctx: AlsContext): boolean;
  isScheduleAuth(ctx: AlsContext): boolean;
  readToolInterrupt(callId: string): unknown;
  skillAnnouncementEntry(ctx: AlsContext): SystemModelMessage | undefined;
}

export interface FailureServices {
  describe(input: { readonly error: unknown; readonly runner: StepCallRunner }): {
    readonly content: StepFailureContent;
    readonly logFields: Record<string, unknown>;
    readonly recognizedTerminal?: {
      readonly fields: Record<string, unknown>;
      readonly message: string;
    };
    readonly taskOutput: unknown;
    readonly upstreamMessage: string | undefined;
  };
  describeStreamWrite(input: { readonly error: unknown; readonly runner: StepCallRunner }): {
    readonly content: StepFailureContent;
    readonly logFields: Record<string, unknown>;
  };
}

export interface UsageServices {
  publish(input: {
    readonly runner: StepCallRunner;
    readonly snapshot: TurnUsageState;
  }): Promise<void>;
}

export interface TraceIdentity {
  readonly environment: string;
  readonly eveVersion: string;
  readonly functionId?: string;
}

export interface TraceServices {
  bind(input: { readonly state: HarnessSession; readonly trace: Span }): HarnessSession;
  end(trace: Span): void;
  readonly identity: TraceIdentity;
  inContext(
    input: { readonly state: HarnessSession; readonly trace: Span | undefined },
    run: () => Promise<GenerateOutcome>,
  ): Promise<GenerateOutcome>;
  recordError(trace: Span, error: unknown): void;
  setAttribute(trace: Span, key: string, value: string): void;
  start(name: string, attributes: Record<string, string>): Span | undefined;
}

export interface StepLog {
  error(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
}

/** Host capabilities used by the concrete core step program. */
export interface StepServices {
  readonly ambient: AmbientServices;
  readonly attachments: AttachmentServices;
  readonly failure: FailureServices;
  readonly log: StepLog;
  readonly modelCall: ModelCallServices;
  readonly trace: TraceServices;
  readonly usage: UsageServices;
}
