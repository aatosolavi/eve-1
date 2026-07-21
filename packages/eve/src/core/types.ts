import type { DeliverHookPayload, HookPayload, SessionCapabilities } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import type { RunMode } from "#shared/run-mode.js";
import type { TokenUsage } from "#shared/token-usage.js";

/**
 * The loop-domain session state: one value carrying both durable cursors
 * that previously threaded every execution boundary separately. The single
 * commit verb for it is {@link TurnBackend.checkpoint}.
 */
export interface SessionState {
  readonly durable: DurableSessionState;
  readonly serializedContext: Record<string, unknown>;
}

/** One turn-facing input: a public delivery or folded-back child results. */
export type TurnInput = HookPayload;

/** One public delivery, as the session program receives it. */
export type Delivery = DeliverHookPayload;

export interface GenerateInput {
  readonly input: TurnInput | undefined;
  readonly state: SessionState;
  readonly stepOrdinal: number;
}

/**
 * A request the model left unresolved at the end of a generation. Requests
 * are identified by their runtime-action key; the durable representation of
 * the open exchange (the pending batch holding the assistant response
 * outside provider history) lives in `state` and travels with it.
 */
export interface LoopRequest {
  readonly key: string;
  readonly kind: "subagent" | "workflow-interrupt";
}

/**
 * The classified outcome of one generation plus its inline tool execution.
 *
 * `waiting` carries the park classification the settle phase needs;
 * `requests` carries unresolved child work; `cancelled` reports an observed
 * turn abort as a value so the engine never treats it as a failure.
 */
export type Generated =
  | { readonly kind: "continue"; readonly state: SessionState }
  | {
      readonly isError?: boolean;
      readonly kind: "finish";
      readonly output: unknown;
      readonly state: SessionState;
      readonly usage?: TokenUsage;
    }
  | {
      readonly authorizationNames?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly kind: "waiting";
      readonly state: SessionState;
    }
  | {
      readonly kind: "requests";
      readonly requests: readonly LoopRequest[];
      readonly state: SessionState;
    }
  | { readonly kind: "cancelled"; readonly state: SessionState };

/**
 * Results of one spawned child batch, in request order, or the sentinel
 * for a turn cancellation observed during the wait.
 */
export type ChildResults = readonly RuntimeActionResult[] | "cancelled";

export interface ChildrenHandle {
  wait(): Promise<{ readonly results: ChildResults; readonly state: SessionState }>;
}

/**
 * Capabilities one intra-turn step may use. Loop mechanics — checkpoint,
 * receive, finish, spawnTurn — are statically invisible to a step.
 */
export interface TurnDependencies {
  generate(input: GenerateInput): Promise<Generated>;
  spawnChildren(
    state: SessionState,
    requests: readonly LoopRequest[],
  ): Promise<{ readonly handle: ChildrenHandle; readonly state: SessionState }>;
}

/** The slice of the port the turn program drives. */
export interface TurnBackend extends TurnDependencies {
  checkpoint(state: SessionState): Promise<void>;
}

/** A completed turn, including the final session state. */
export type CompletedTurn = Extract<TurnOutcome, { readonly kind: "done" }>;

/** A parked turn whose reason must cross the session boundary intact. */
export type SuspendedTurn = Exclude<TurnOutcome, CompletedTurn>;

/** The result of parking a suspended turn at the engine boundary. */
export type SessionAdvance =
  | {
      readonly delivery: Delivery;
      readonly kind: "delivery";
      readonly state: SessionState;
    }
  | { readonly kind: "closed"; readonly outcome: TerminalOutcome };

/** Engine operations used only by the shared session program. */
export interface SessionBackend {
  finish(turn: CompletedTurn): Promise<void>;
  park(turn: SuspendedTurn): Promise<SessionAdvance>;
  spawnTurn(input: TurnProgramInput, turnOrdinal: number): TurnHandle;
}

export interface StepInput {
  readonly input: TurnInput | undefined;
  readonly state: SessionState;
  readonly stepOrdinal: number;
}

/**
 * One step's result in the iterator protocol's shape: `done: false`
 * continues the turn loop (carrying the next step's input, e.g. folded
 * child results), `done: true` carries the turn's completion.
 */
export type StepResult =
  | {
      readonly done: false;
      readonly nextInput: TurnInput | undefined;
      readonly state: SessionState;
    }
  | {
      readonly done: true;
      readonly isError?: boolean;
      readonly kind: "done";
      readonly output: unknown;
      readonly state: SessionState;
      readonly usage?: TokenUsage;
    }
  | {
      readonly authorizationNames?: readonly string[];
      readonly done: true;
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly kind: "waiting";
      readonly state: SessionState;
    }
  | { readonly done: true; readonly kind: "cancelled"; readonly state: SessionState };

export interface TurnProgramInput {
  readonly capabilities: SessionCapabilities | undefined;
  readonly delivery: TurnInput | undefined;
  readonly mode: RunMode;
  readonly state: SessionState;
}

export type TurnOutcome =
  | {
      readonly isError?: boolean;
      readonly kind: "done";
      readonly output: unknown;
      readonly state: SessionState;
      readonly usage?: TokenUsage;
    }
  | {
      readonly authorizationNames?: readonly string[];
      readonly hasPendingAuthorization: boolean;
      readonly hasPendingInputBatch: boolean;
      readonly kind: "waiting";
      readonly state: SessionState;
    }
  | { readonly kind: "cancelled"; readonly state: SessionState };

export interface TurnHandle {
  wait(): Promise<TurnOutcome>;
}

export interface TerminalOutcome {
  readonly isError?: boolean;
  readonly output: unknown;
  readonly usage?: TokenUsage;
}

export interface SessionProgramInput {
  readonly capabilities: SessionCapabilities | undefined;
  readonly initialDelivery: Delivery;
  readonly mode: RunMode;
  readonly state: SessionState;
}
