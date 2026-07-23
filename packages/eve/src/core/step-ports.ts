import type { LoopMode, TurnStepResult } from "#core/types.js";

/**
 * The dependency surface of one generate step.
 *
 * Ports are *dependencies*, not operations: each member is a primitive
 * capability (an emitter, a tracer, a predicate, one subsystem call) or a
 * facet (a typed accessor over an otherwise opaque payload). Every
 * composition built from them — ordering, branching, loops, choreography —
 * lives in the core step flow (`turn-before-call.ts`, `turn-call.ts`).
 * A port earns a spot here only when there is no level below it short of
 * absorbing an entire implementation subsystem.
 */

/**
 * The value shapes one step flow is generic over. Core never inspects
 * them; the implementation binds concrete types once and exposes exactly
 * the facets the flow needs.
 */
export interface StepFlowTypes {
  /** Per-step ambient runtime context (absent in direct unit tests). */
  readonly ambientContext: unknown;
  /** One item of a rejected-approval batch. */
  readonly approvalResult: unknown;
  /** One prepared model-call attempt input. */
  readonly callAttempt: unknown;
  /** One model call's raw result before settlement. */
  readonly callResult: unknown;
  /** The prepared model-call runner one step drives. */
  readonly callRunner: unknown;
  /** The provider cache path detected for the active model. */
  readonly cachePath: unknown;
  /** The provider cache marker for direct-provider prompt caching. */
  readonly cacheMarker: unknown;
  /** The model resolved to write compaction summaries. */
  readonly compactionModel: unknown;
  /** Emission coordinates threaded through lifecycle events. */
  readonly emissionState: unknown;
  /** Described failure content consumed by failure events. */
  readonly failureContent: unknown;
  /** One entry of the durable message history. */
  readonly historyEntry: unknown;
  /** A resolved session-limit continuation grant, when one arrived. */
  readonly limitGrant: unknown;
  /** Structured fields attached to flow log lines. */
  readonly logFields: unknown;
  /** The resolved active model. */
  readonly model: unknown;
  /** Gateway attribution headers for the active model. */
  readonly modelHeaders: unknown;
  /** The assembled prompt: everything one model call consumes. */
  readonly prompt: unknown;
  /** Denied tool-call approvals surfaced back to consumers. */
  readonly rejectedApprovals: unknown;
  /** Call-shape options a failed recovery stage hands to the next. */
  readonly retryOptions: unknown;
  /** The session state. */
  readonly state: unknown;
  /** One step's input payload. */
  readonly stepInput: unknown;
  /** The observability trace of one turn, opened on its first step. */
  readonly turnTrace: unknown;
  /** Provider-reported token usage of one completed step. */
  readonly usage: unknown;
  /** The accumulated per-turn usage snapshot published to observability. */
  readonly usageSnapshot: unknown;
  /** One user-content payload appended to the history. */
  readonly userContent: unknown;
}

/**
 * The step's outcome is core vocabulary, not an opaque slot: the flow
 * produces the same {@link TurnStepResult} the outer loop programs
 * interpret, so core constructs completions itself.
 */
export type StepOutcome<S extends StepFlowTypes> = TurnStepResult<{
  readonly childResult: unknown;
  readonly delivery: unknown;
  readonly state: S["state"];
  readonly usage: S["usage"];
}>;

/** Typed accessors over otherwise opaque payloads. */
export interface StepFacets<S extends StepFlowTypes> {
  /** Items of one rejected-approval batch, in emission order. */
  approvalResultsOf(batch: S["rejectedApprovals"]): readonly S["approvalResult"][];
  /** The delivery's context entries; `undefined` when it carries none. */
  contextEntriesOf(input: S["stepInput"] | undefined): readonly S["userContent"][] | undefined;
  /** The delivery's normalized message content; `undefined` when absent. */
  deliveryContentOf(input: S["stepInput"] | undefined): S["userContent"] | undefined;
  /** Whether the raw input carries a fresh delivery (opens a new turn). */
  hasDelivery(input: S["stepInput"] | undefined): boolean;
  /** Whether the state pins a structured output schema. */
  hasOutputSchema(state: S["state"]): boolean;
  /** Reads the emission coordinates persisted on the state. */
  readEmission(state: S["state"]): S["emissionState"];
  sessionIdOf(state: S["state"]): string;
  turnIdOf(emissionState: S["emissionState"]): string;
  /** Stamps emission coordinates onto the state. */
  writeEmission(state: S["state"], emissionState: S["emissionState"]): S["state"];
}

/**
 * The event stream. `undefined` on the ports means the step runs without
 * an emitter — internal callers — and every event site is skipped. Each
 * method emits exactly one lifecycle event; the choreography between them
 * is core flow.
 */
export interface EventStream<S extends StepFlowTypes> {
  compactionCompleted(input: {
    readonly compactionModel: S["compactionModel"];
    readonly emissionState: S["emissionState"];
    readonly state: S["state"];
  }): Promise<void>;
  compactionRequested(input: {
    readonly compactionModel: S["compactionModel"];
    readonly emissionState: S["emissionState"];
    readonly history: readonly S["historyEntry"][];
    readonly state: S["state"];
  }): Promise<void>;
  /** Emits the failed step; the content carries code and details. */
  failedStep(input: {
    readonly content: S["failureContent"];
    readonly emissionState: S["emissionState"];
    readonly state: S["state"];
  }): Promise<void>;
  /** Emits the recoverable turn failure; returns the advanced coordinates. */
  recoverableFailedTurn(input: {
    readonly content: S["failureContent"];
    readonly emissionState: S["emissionState"];
    readonly state: S["state"];
  }): Promise<S["emissionState"]>;
  /** Surfaces one denied tool-call approval as a rejected action result. */
  rejectedApproval(input: {
    readonly batch: S["rejectedApprovals"];
    readonly result: S["approvalResult"];
  }): Promise<void>;
  stepStarted(input: {
    readonly emissionState: S["emissionState"];
    readonly prompt: S["prompt"];
  }): Promise<void>;
  turnEpilogue(input: {
    readonly emissionState: S["emissionState"];
    readonly state: S["state"];
  }): Promise<S["emissionState"]>;
  turnPreamble(input: {
    readonly emissionState: S["emissionState"];
    readonly input: S["stepInput"] | undefined;
  }): Promise<S["emissionState"]>;
}

/** Structured flow logging; messages are core statements of core decisions. */
export interface FlowLog<S extends StepFlowTypes> {
  error(message: string, fields: S["logFields"]): void;
  warn(message: string, fields: S["logFields"]): void;
}

/** Identity attributes stamped onto the turn trace. */
export interface TraceIdentity {
  readonly environment: string;
  readonly eveVersion: string;
  readonly functionId?: string;
}

/** Tracing primitives; the envelope built from them is core flow. */
export interface TraceDependencies<S extends StepFlowTypes> {
  /** Stamps the open trace onto the state for continuation steps. */
  bind(input: { readonly state: S["state"]; readonly trace: S["turnTrace"] }): S["state"];
  end(trace: S["turnTrace"]): void;
  /** Runs the step inside the trace's (or the restored parent's) context. */
  inContext(
    input: { readonly state: S["state"]; readonly trace: S["turnTrace"] | undefined },
    run: () => Promise<StepOutcome<S>>,
  ): Promise<StepOutcome<S>>;
  recordError(trace: S["turnTrace"], error: unknown): void;
  setAttribute(trace: S["turnTrace"], key: string, value: string): void;
  /** Opens a span; `undefined` when tracing is disabled. */
  start(name: string, attributes: Record<string, string>): S["turnTrace"] | undefined;
}

/**
 * The waits of turn-input resolution. Each member is one implementation
 * subsystem — the level below it is that subsystem's internals, so the
 * subsystem call itself is the dependency.
 */
export interface WaitDependencies<S extends StepFlowTypes> {
  /**
   * Applies a resolved session-limit continuation: a non-null outcome
   * settles the step (denied continuation).
   */
  applyLimitContinuation(input: {
    readonly emissionState: S["emissionState"];
    readonly limitGrant: S["limitGrant"] | undefined;
    readonly state: S["state"];
  }): Promise<{ readonly outcome: StepOutcome<S> | null; readonly state: S["state"] }>;
  /** Replays input deferred by a previous step in place of fresh input. */
  consumeDeferredInput(input: {
    readonly input: S["stepInput"] | undefined;
    readonly state: S["state"];
  }): { readonly input: S["stepInput"] | undefined; readonly state: S["state"] };
  /**
   * Converts input responses addressed to requests that no longer exist
   * into a plain user message. `displayInput` is what lifecycle events
   * show; `effectiveInput` is what the model sees.
   */
  convertStaleResponses(input: {
    readonly history: readonly S["historyEntry"][];
    readonly input: S["stepInput"] | undefined;
    readonly state: S["state"];
  }): {
    readonly displayInput: S["stepInput"] | undefined;
    readonly effectiveInput: S["stepInput"] | undefined;
  };
  /** Resolves the pending HITL input batch; `unresolved` parks the step. */
  resolvePendingInput(input: {
    readonly history: readonly S["historyEntry"][];
    readonly input: S["stepInput"] | undefined;
    readonly state: S["state"];
  }):
    | {
        readonly outcome: "resolved";
        readonly consumedMessage?: boolean;
        readonly deferredContext?: boolean;
        readonly deferredMessage?: boolean;
        readonly history: readonly S["historyEntry"][];
        readonly limitGrant: S["limitGrant"] | undefined;
        readonly rejectedApprovals: S["rejectedApprovals"] | undefined;
        readonly state: S["state"];
      }
    | {
        readonly outcome: "unresolved";
        readonly deferredMessage?: boolean;
        readonly state: S["state"];
      };
  /**
   * Folds completed child-action results into the history. `unresolved`
   * means results are still outstanding: the step parks.
   */
  resolveRuntimeActions(input: {
    readonly input: S["stepInput"] | undefined;
    readonly state: S["state"];
  }): Promise<
    | {
        readonly outcome: "resolved";
        readonly history: readonly S["historyEntry"][];
        readonly state: S["state"];
      }
    | { readonly outcome: "unresolved"; readonly state: S["state"] }
  >;
}

/** Prompt-assembly primitives; the pipeline over them is core flow. */
export interface PromptDependencies<S extends StepFlowTypes> {
  /** The system entry instructing conditional delivery on schedule runs. */
  conditionalDeliveryEntry(): S["historyEntry"];
  /** Dynamic-instruction system entries registered on the context. */
  dynamicInstructionEntries(ctx: S["ambientContext"]): readonly S["historyEntry"][];
  /** Composes the final prompt record from core-assembled parts. */
  finalize(input: {
    readonly attributionHeaders: S["modelHeaders"];
    readonly cacheMarker: S["cacheMarker"] | undefined;
    readonly cachePath: S["cachePath"];
    readonly ctx: S["ambientContext"] | undefined;
    readonly emptyDeliveryEnabled: boolean;
    readonly history: readonly S["historyEntry"][];
    readonly model: S["model"];
    readonly modelEntries: readonly S["historyEntry"][];
    readonly state: S["state"];
    readonly systemEntries: readonly S["historyEntry"][];
  }): S["prompt"];
  /** Hydrates ref-only attachment entries into inline bytes (transient). */
  hydrate(history: readonly S["historyEntry"][]): Promise<readonly S["historyEntry"][]>;
  isSystemEntry(entry: S["historyEntry"]): boolean;
  /** The pending skill announcement as a system entry, when one exists. */
  skillAnnouncementEntry(ctx: S["ambientContext"]): S["historyEntry"] | undefined;
  /** Writes attachment bytes to the sandbox, returning ref-only content. */
  stageAttachments(content: S["userContent"]): Promise<S["userContent"]>;
  /** Wraps user content as one history entry. */
  userEntry(content: S["userContent"]): S["historyEntry"];
}

/** Model-resolution primitives and ambient-context facets. */
export interface ModelDependencies<S extends StepFlowTypes> {
  readonly ambient: () => S["ambientContext"] | undefined;
  anthropicCacheMarker(): S["cacheMarker"];
  attributionHeaders(model: S["model"]): S["modelHeaders"];
  /** Detects the provider cache path; `kind` is the core-visible tag. */
  cachePlan(model: S["model"]): { readonly kind: string; readonly path: S["cachePath"] };
  /** Dispatches the dynamic-model hook; absent when the agent has none. */
  readonly dispatchDynamicModel?: (input: {
    readonly ctx: S["ambientContext"];
    readonly emissionState: S["emissionState"];
    readonly history: readonly S["historyEntry"][];
    readonly state: S["state"];
  }) => Promise<void>;
  hasParentSession(ctx: S["ambientContext"]): boolean;
  isScheduleAuth(ctx: S["ambientContext"]): boolean;
  resolve(input: {
    readonly ctx: S["ambientContext"] | undefined;
    readonly state: S["state"];
  }): Promise<{ readonly model: S["model"]; readonly state: S["state"] }>;
}

/** Compaction primitives; the run choreography is core flow. */
export interface CompactionDependencies<S extends StepFlowTypes> {
  /** Framework entries re-appended after a compaction pass. */
  postCompactionEntries(): readonly S["historyEntry"][];
  resolveModel(input: {
    readonly model: S["model"];
    readonly state: S["state"];
  }): Promise<S["compactionModel"]>;
  run(input: {
    readonly compactionModel: S["compactionModel"];
    readonly history: readonly S["historyEntry"][];
    readonly state: S["state"];
  }): Promise<readonly S["historyEntry"][]>;
  shouldCompact(history: readonly S["historyEntry"][], state: S["state"]): boolean;
}

/**
 * One in-process recovery attempt over a failed model call. `skipped`
 * means the stage did not apply; the loop keeps the current error.
 */
export type RecoveryStage<S extends StepFlowTypes> = (input: {
  readonly error: unknown;
  readonly retryOptions: S["retryOptions"] | undefined;
  readonly runner: S["callRunner"];
}) => Promise<
  | { readonly outcome: "recovered"; readonly result: S["callResult"] }
  | {
      readonly outcome: "failed";
      readonly error: unknown;
      readonly retryOptions?: S["retryOptions"];
    }
  | { readonly outcome: "skipped" }
>;

/** Model-call primitives; preflight order and recovery loop are core flow. */
export interface CallDependencies<S extends StepFlowTypes> {
  /** Throws the implementation's cancellation error when the turn aborted. */
  assertNotCancelled(): void;
  /**
   * Replays a pending workflow-interrupt continuation. A non-null outcome
   * settles the step without a model call.
   */
  continueWorkflowInterrupt(input: {
    readonly emissionState: S["emissionState"];
    readonly input: S["stepInput"] | undefined;
    readonly prompt: S["prompt"];
  }): Promise<StepOutcome<S> | null>;
  create(input: {
    readonly emissionState: S["emissionState"];
    readonly prompt: S["prompt"];
  }): S["callRunner"];
  /** Latest state snapshot, including updates made by call attempts. */
  currentState(runner: S["callRunner"]): S["state"];
  /**
   * Enforces the session token budget. A non-null outcome settles the
   * step without a model call.
   */
  enforceTokenLimit(input: {
    readonly emissionState: S["emissionState"];
    readonly prompt: S["prompt"];
  }): Promise<StepOutcome<S> | null>;
  /** Resolves one attempt's call input. */
  prepareAttempt(runner: S["callRunner"]): S["callAttempt"];
  /** In-process recovery attempts, in the order core runs them. */
  readonly recoveryStages: readonly RecoveryStage<S>[];
  run(input: {
    readonly attempt: S["callAttempt"];
    readonly runner: S["callRunner"];
  }): Promise<S["callResult"]>;
}

/** Failure predicates and content derivation; the decision tree is core. */
export interface FailureDependencies<S extends StepFlowTypes> {
  classification(error: unknown): "recoverable" | "retry" | "terminal";
  /** Derives the shared content of one unrecovered model-call failure. */
  describe(input: { readonly error: unknown; readonly runner: S["callRunner"] }): {
    readonly content: S["failureContent"];
    readonly logFields: S["logFields"];
    /** Concise log override for recognized configuration failures. */
    readonly recognizedTerminal?: { readonly fields: S["logFields"]; readonly message: string };
    readonly taskOutput: unknown;
    readonly upstreamMessage: string | undefined;
  };
  describeStreamWrite(input: { readonly error: unknown; readonly runner: S["callRunner"] }): {
    readonly content: S["failureContent"];
    readonly logFields: S["logFields"];
  };
  /** Whether the error already consumed its in-process retry budget. */
  isRetryBudgetConsumed(error: unknown): boolean;
  /** A durable event-stream write failure, not a model failure. */
  isStreamWriteFailure(error: unknown): boolean;
}

/** Usage-accounting primitives; the always-account order is core flow. */
export interface UsageDependencies<S extends StepFlowTypes> {
  /** Folds the call's usage delta into the per-turn running total. */
  accumulate(input: { readonly result: S["callResult"]; readonly runner: S["callRunner"] }): {
    readonly snapshot: S["usageSnapshot"];
    readonly state: S["state"];
  };
  /** Publishes the running total to the observability attribute store. */
  publish(input: {
    readonly runner: S["callRunner"];
    readonly snapshot: S["usageSnapshot"];
  }): Promise<void>;
}

/** Outcome classification over implementation state. */
export interface SettleDependencies<S extends StepFlowTypes> {
  /**
   * Classifies a state that must wait as the parked outcome, stamping the
   * emission coordinates when the turn was opened.
   */
  parked(input: {
    readonly emissionState?: S["emissionState"];
    readonly state: S["state"];
  }): StepOutcome<S>;
  /** Classifies the successful call into the step's outcome. */
  step(input: {
    readonly emissionState: S["emissionState"];
    readonly prompt: S["prompt"];
    readonly result: S["callResult"];
    readonly state: S["state"];
  }): Promise<StepOutcome<S>>;
}

/** The complete dependency surface one generate step drives. */
export interface StepPorts<S extends StepFlowTypes> {
  readonly call: CallDependencies<S>;
  readonly compaction: CompactionDependencies<S>;
  /** `undefined` when the step runs without an event stream. */
  readonly events: EventStream<S> | undefined;
  readonly facets: StepFacets<S>;
  readonly failure: FailureDependencies<S>;
  readonly identity: TraceIdentity;
  readonly log: FlowLog<S>;
  /** Done-versus-park semantics owner for failed calls. */
  readonly mode: LoopMode;
  readonly model: ModelDependencies<S>;
  readonly prompt: PromptDependencies<S>;
  readonly settle: SettleDependencies<S>;
  readonly trace: TraceDependencies<S>;
  readonly usage: UsageDependencies<S>;
  readonly waits: WaitDependencies<S>;
}
