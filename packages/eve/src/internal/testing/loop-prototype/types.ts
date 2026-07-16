declare const brand: unique symbol;
const balanced: unique symbol = Symbol("BalancedHistory");

export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type ChildId = Brand<string, "ChildId">;
export type EventId = Brand<string, "EventId">;
export type EventLogId = Brand<string, "EventLogId">;
export type ExecutionId = Brand<string, "ExecutionId">;
export type OperationId = Brand<string, "OperationId">;
export type SessionId = Brand<string, "SessionId">;

export type WireValue =
  | null
  | boolean
  | number
  | string
  | readonly WireValue[]
  | { readonly [key: string]: WireValue };

export interface UserMessage {
  readonly content: string;
  readonly role: "user";
}

export interface AssistantMessage {
  readonly content: string;
  readonly requestIds: readonly string[];
  readonly role: "assistant";
}

export interface ToolMessage {
  readonly content: WireValue;
  readonly isError: boolean;
  readonly requestId: string;
  readonly role: "tool";
}

export type HistoryMessage = UserMessage | AssistantMessage | ToolMessage;

export type BalancedHistory = readonly HistoryMessage[] & { readonly [balanced]: true };

export function createBalancedHistory(messages: readonly HistoryMessage[]): BalancedHistory {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user") continue;
    if (message?.role === "tool") {
      throw new TypeError(`Tool result "${message.requestId}" has no preceding request.`);
    }
    if (message === undefined) throw new TypeError("History contains a missing message.");

    const requestIds = message.requestIds;
    if (new Set(requestIds).size !== requestIds.length) {
      throw new TypeError("Assistant history message contains duplicate request IDs.");
    }
    for (const [offset, requestId] of requestIds.entries()) {
      const result = messages[index + offset + 1];
      if (result?.role !== "tool" || result.requestId !== requestId) {
        throw new TypeError(`Assistant request "${requestId}" has no matching result.`);
      }
    }
    index += requestIds.length;
  }

  const history = Object.assign([...messages], { [balanced]: true as const });
  Object.defineProperty(history, balanced, { enumerable: false });
  return history;
}

export type LoopRequest = ToolRequest | ApprovalRequest | SubagentRequest;

export interface ToolRequest {
  readonly input: WireValue;
  readonly kind: "tool";
  readonly name: string;
  readonly requestId: string;
}

export interface ApprovalRequest {
  readonly input: WireValue;
  readonly kind: "approval";
  readonly name: string;
  readonly requestId: string;
}

export interface SubagentRequest {
  readonly delayMs: number;
  readonly kind: "subagent";
  readonly message: string;
  readonly requestId: string;
}

export interface RequestResult {
  readonly isError: boolean;
  readonly requestId: string;
  readonly value: WireValue;
}

export interface OpenExchange {
  readonly assistant: AssistantMessage;
  readonly requests: readonly LoopRequest[];
  readonly results: readonly (RequestResult | null)[];
}

export type Scenario =
  | { readonly delayMs?: number; readonly kind: "echo" }
  | { readonly kind: "tool" }
  | { readonly kind: "tool-fail" }
  | { readonly kind: "approval" }
  | {
      readonly children: readonly { readonly delayMs: number; readonly message: string }[];
      readonly kind: "children";
    }
  | { readonly kind: "retry-once" }
  | { readonly kind: "infrastructure-fail" }
  | { readonly kind: "fail" };

export interface SessionState {
  readonly bufferedDeliveries: readonly Delivery[];
  readonly history: BalancedHistory;
  readonly mode: "conversation" | "task";
  readonly nextTurnOrdinal: number;
  readonly pending: OpenExchange | null;
  readonly phase: "between-turns" | "turn" | "terminal";
  readonly scenario: Scenario;
  readonly sessionId: SessionId;
}

export interface SessionCheckpoint {
  readonly leaseOwner: ExecutionId;
  readonly revision: number;
  readonly state: SessionState;
  readonly version: 1;
}

export interface SerializableFailure {
  readonly code: string;
  readonly message: string;
}

export type TerminalOutcome =
  | { readonly kind: "completed"; readonly output: WireValue }
  | { readonly error: SerializableFailure; readonly kind: "failed" };

export interface MessageDelivery {
  readonly deliveryId: string;
  readonly kind: "message";
  readonly message: string;
}

export interface ApprovalDelivery {
  readonly approved: boolean;
  readonly deliveryId: string;
  readonly kind: "approval";
  readonly requestId: string;
}

export type Delivery = MessageDelivery | ApprovalDelivery;

export type RetryPolicy =
  | { readonly idempotency: "required"; readonly maxAttempts: number }
  | { readonly idempotency: "none"; readonly maxAttempts: 1 };

export interface GeneratedTurn {
  readonly assistant: AssistantMessage;
  readonly finish: { readonly output: WireValue } | null;
  readonly requests: readonly LoopRequest[];
}

export interface GenerateInput {
  readonly generationOrdinal: number;
  readonly history: BalancedHistory;
  readonly scenario: Scenario;
  readonly sessionId: SessionId;
  readonly turnOrdinal: number;
}

export type EffectCall =
  | {
      readonly id: OperationId;
      readonly input: GenerateInput;
      readonly name: "generate";
      readonly retry: RetryPolicy;
    }
  | {
      readonly id: OperationId;
      readonly input: ApprovalRequest | ToolRequest;
      readonly name: "execute-tool";
      readonly retry: RetryPolicy;
    };

export type EffectResult =
  | { readonly kind: "succeeded"; readonly output: WireValue }
  | { readonly error: SerializableFailure; readonly kind: "exhausted" };

export interface StreamEvent {
  readonly id: EventId;
  readonly operationId: OperationId;
  readonly payload: WireValue;
}

export interface EventRecord {
  readonly id: EventId;
  readonly logId: EventLogId;
  readonly operationId: OperationId;
  readonly payload: WireValue;
  readonly sequence: number;
}

export interface SessionProgramInput {
  readonly initialDelivery: MessageDelivery;
  readonly mode: "conversation" | "task";
  readonly scenario: Scenario;
  readonly sessionId: SessionId;
}

export interface TurnProgramInput {
  readonly delivery: Delivery;
  readonly state: SessionState;
}

export type TurnOutcome =
  | {
      readonly kind: "conversation-replied";
      readonly output: WireValue;
      readonly state: SessionState;
    }
  | {
      readonly kind: "waiting-approval";
      readonly requestId: string;
      readonly state: SessionState;
    }
  | {
      readonly kind: "task-terminal";
      readonly state: SessionState;
      readonly terminal: TerminalOutcome;
    };

export interface DelegatedSessionInput extends SessionProgramInput {
  readonly requestId: string;
}

export interface ChildHandle {
  readonly id: ChildId;
  wait(): Promise<TerminalOutcome>;
}

export interface TurnHandle {
  readonly id: ChildId;
  wait(): Promise<TurnOutcome>;
}

export interface Stream {
  append(event: StreamEvent): Promise<void>;
}

export interface LoopBackend {
  readonly executionId: ExecutionId;
  readonly stream: Stream;

  checkpoint(state: SessionState): Promise<void>;
  executeTool(request: ApprovalRequest | ToolRequest): Promise<RequestResult>;
  finish(outcome: TerminalOutcome): Promise<void>;
  generate(input: GenerateInput): Promise<GeneratedTurn>;
  receive(): Promise<Delivery>;
  spawnChild(input: DelegatedSessionInput): ChildHandle;
  spawnTurn(input: TurnProgramInput): TurnHandle;
}

export interface PrototypeEventStore {
  append(logId: EventLogId, event: StreamEvent): Promise<EventRecord>;
  read(logId: EventLogId): Promise<readonly EventRecord[]>;
}

export interface PrototypeStartInput extends SessionProgramInput {
  readonly continuationToken: string;
}

export interface PrototypeRun {
  readonly backendRunId: string;
  readonly result: Promise<TerminalOutcome>;
  readonly sessionId: SessionId;

  deliver(delivery: Delivery): Promise<void>;
  events(): Promise<readonly EventRecord[]>;
  stop(): Promise<void>;
}

export interface PrototypeRuntime {
  readonly kind: "inline" | "temporal" | "workflow";

  attemptCount(operationId: OperationId): Promise<number>;
  callback(sessionId: SessionId): Promise<TerminalOutcome | null>;
  close(): Promise<void>;
  events(logId: EventLogId): Promise<readonly EventRecord[]>;
  executionCount(operationId: OperationId): Promise<number>;
  start(input: PrototypeStartInput): Promise<PrototypeRun>;
  visibleEffectCount(operationId: OperationId): Promise<number>;
}
