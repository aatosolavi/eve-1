import type { ModelMessage } from "ai";

import type { DeliverPayload, DeliverHookPayload, HookPayload } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import {
  CallbackBaseUrlKey,
  clearPendingAuthorization,
  getPendingAuthorization,
  PendingAuthorizationResultKey,
  type AuthorizationResult,
} from "#core/authorization.js";
import { AuthKey, ModeKey } from "#core/context/keys.js";
import {
  createDurableSessionState,
  type DurableSession,
  type DurableSessionState,
} from "#core/durable-session-store.js";
import { getHarnessEmissionState } from "#core/emission.js";
import { coalesceTurnInputs } from "#core/messages.js";
import {
  createAuthorizationCompletedEvent,
  type HandleMessageStreamEvent,
} from "#core/protocol/message.js";
import { reconcileSessionContinuationToken } from "#core/reconcile-session-continuation-token.js";
import type { RuntimeActionResult } from "#core/actions/types.js";
import type { JsonObject } from "#core/shared/json.js";
import type { TokenUsage } from "#core/shared/token-usage.js";
import { classifyParkedSession, withOutcomeState } from "#core/step-outcome.js";
import { getTurnUsageState, toUsage } from "#core/turn-tag-state.js";
import { isTurnCancellation, throwIfTurnAborted } from "#core/turn-cancellation.js";
import type { LoopTypes, TurnStepResult } from "#core/types.js";
import type {
  GenerateOutcome,
  HandleEventFn,
  HarnessSession,
  StepInput,
} from "#core/step-types.js";
import type { ConnectionAuthorizationChallenge } from "#public/connections/errors.js";
import type { AuthorizationCallback } from "#runtime/connections/types.js";

type SerializedContext = Record<string, unknown>;

interface EntryLoopTypes extends LoopTypes {
  readonly childResult: RuntimeActionResult;
  readonly delivery: DeliverHookPayload;
  readonly state: ProjectedState;
  readonly usage: TokenUsage;
}

interface AuthorizationCallbackPayload {
  readonly callback: AuthorizationCallback;
  readonly connectionName: string;
}

interface AuthorizationCompletion {
  readonly authorization: ConnectionAuthorizationChallenge;
  readonly name: string;
}

/** The serialized cursors one engine persists across steps. */
export interface ProjectedState {
  readonly durable: DurableSessionState;
  readonly serializedContext: SerializedContext;
}

/** The concrete outcome returned to every eve loop engine. */
export type EntryOutcome = TurnStepResult<EntryLoopTypes>;

/** Runtime-owned values recovered with the serialized context. */
export interface RestoredEntryContext {
  readonly agentOutputSchema: JsonObject | undefined;
  readonly ctx: ContextContainer;
}

/** Host effects used by the engine-neutral durable-step program. */
export interface EntryServices {
  readonly cancellation: {
    readonly abortSignal: AbortSignal | undefined;
  };
  readonly channel: {
    deliver(ctx: ContextContainer, payload: DeliverPayload): Promise<StepInput | null | undefined>;
    pinAdapterState(ctx: ContextContainer): void;
    transformEvent(
      ctx: ContextContainer,
      event: HandleMessageStreamEvent,
    ): Promise<HandleMessageStreamEvent>;
  };
  readonly codec: {
    restore(serialized: SerializedContext): Promise<RestoredEntryContext>;
    serialize(ctx: ContextContainer): SerializedContext;
  };
  readonly generate: (input: {
    readonly ctx: ContextContainer;
    readonly handleEvent: HandleEventFn;
    readonly input: StepInput | undefined;
    readonly session: HarnessSession;
  }) => Promise<GenerateOutcome>;
  readonly hooks: {
    dispatchDynamicInstructions(
      ctx: ContextContainer,
      event: HandleMessageStreamEvent,
      messages: readonly ModelMessage[] | undefined,
    ): Promise<void>;
    dispatchDynamicModel(
      ctx: ContextContainer,
      event: HandleMessageStreamEvent,
      messages: readonly ModelMessage[] | undefined,
    ): Promise<void>;
    dispatchDynamicSkills(
      ctx: ContextContainer,
      event: HandleMessageStreamEvent,
      messages: readonly ModelMessage[] | undefined,
    ): Promise<void>;
    dispatchDynamicTools(
      ctx: ContextContainer,
      event: HandleMessageStreamEvent,
      messages: readonly ModelMessage[] | undefined,
    ): Promise<void>;
    dispatchStreamHooks(ctx: ContextContainer, event: HandleMessageStreamEvent): Promise<void>;
    recordChildUsageSpans(results: readonly RuntimeActionResult[]): void;
  };
  readonly scope: {
    run(
      ctx: ContextContainer,
      session: HarnessSession,
      fn: (enriched: HarnessSession) => Promise<GenerateOutcome>,
    ): Promise<GenerateOutcome>;
  };
  readonly sessions: {
    hydrate(ctx: ContextContainer, durable: DurableSession): HarnessSession;
    refresh(ctx: ContextContainer, session: HarnessSession): HarnessSession;
  };
  readonly stream: {
    close(writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void>;
    open(): WritableStreamDefaultWriter<Uint8Array>;
    release(writer: WritableStreamDefaultWriter<Uint8Array>): void;
    write(
      writer: WritableStreamDefaultWriter<Uint8Array>,
      event: HandleMessageStreamEvent,
    ): Promise<void>;
  };
}

/** The engine-supplied inputs of one durable step. */
export interface StepEntryInput {
  /** Callback base URL, when the host resolved one. */
  readonly callbackBaseUrl: string | undefined;
  /** The parsed durable session the engine pre-read. */
  readonly durableSession: DurableSession;
  /** The persisted snapshot behind it, reused when nothing changed. */
  readonly durableSnapshot: DurableSessionState;
  readonly serializedContext: SerializedContext;
  readonly turnInput: HookPayload | undefined;
}

/**
 * Restores one durable step, resolves its input, runs generation inside the
 * active context scope, and projects the result back onto durable cursors.
 */
export async function runStepEntrypoint(
  services: EntryServices,
  input: StepEntryInput,
): Promise<EntryOutcome> {
  const restored = await services.codec.restore(input.serializedContext);
  const { ctx } = restored;

  if (input.callbackBaseUrl !== undefined) {
    ctx.set(CallbackBaseUrlKey, input.callbackBaseUrl);
  }

  let turnInput = input.turnInput;
  let durable = input.durableSession;
  let completions: readonly AuthorizationCompletion[] | undefined;
  const pending = getPendingAuthorization(durable.state);

  if (pending !== undefined && turnInput?.kind === "deliver") {
    const results: Array<{ readonly name: string } & AuthorizationResult> = [];
    const names: string[] = [];
    const completed: AuthorizationCompletion[] = [];
    const remaining: DeliverPayload[] = [];

    for (const payload of turnInput.payloads) {
      const callback = readAuthorizationCallback(payload);
      if (callback === undefined) {
        remaining.push(payload);
        continue;
      }

      const challenge = pending.challenges.find(
        (candidate) => candidate.name === callback.connectionName,
      );
      if (challenge !== undefined) {
        completed.push({ authorization: challenge.challenge, name: challenge.name });
        names.push(challenge.name);
        results.push({
          callback: callback.callback,
          hookUrl: challenge.hookUrl,
          name: challenge.name,
          resume: challenge.resume,
        });
      }
    }

    if (results.length > 0) {
      ctx.set(PendingAuthorizationResultKey, results);
      durable = {
        ...durable,
        state: clearPendingAuthorization(durable.state, names),
      };
      completions = completed;
    }

    turnInput = remaining.length > 0 ? { ...turnInput, payloads: remaining } : undefined;
  }

  if (turnInput?.kind === "deliver" && turnInput.auth !== undefined) {
    ctx.set(AuthKey, turnInput.auth);
  }

  const session = services.sessions.hydrate(ctx, durable);
  let resolved: StepInput | undefined;

  if (turnInput?.kind === "deliver") {
    const inputs: StepInput[] = [];
    for (const payload of turnInput.payloads) {
      const result = await services.channel.deliver(ctx, payload);
      if (result !== undefined && result !== null) {
        inputs.push(result);
      }
    }
    resolved = inputs.length === 0 ? undefined : inputs.reduce(coalesceTurnInputs);
    services.channel.pinAdapterState(ctx);
  } else if (turnInput?.kind === "runtime-action-result") {
    services.hooks.recordChildUsageSpans(turnInput.results);
    resolved = { runtimeActionResults: turnInput.results };
  }

  if (turnInput?.kind === "deliver" && resolved === undefined) {
    const rekeyed = reconcileSessionContinuationToken(ctx, session);
    return withOutcomeState<EntryLoopTypes>(classifyParkedSession(rekeyed), {
      durable:
        rekeyed === session
          ? input.durableSnapshot
          : createDurableSessionState({ session: rekeyed }),
      serializedContext: services.codec.serialize(ctx),
    });
  }

  const writer = services.stream.open();
  const handleEvent: HandleEventFn = async (event, messages) => {
    const emitted = await services.channel.transformEvent(ctx, event);
    await services.stream.write(writer, emitted);
    await services.hooks.dispatchStreamHooks(ctx, emitted);
    if (emitted.type !== "step.started") {
      await services.hooks.dispatchDynamicModel(ctx, emitted, messages);
    }
    await services.hooks.dispatchDynamicTools(ctx, emitted, messages);
    await services.hooks.dispatchDynamicSkills(ctx, emitted, messages);
    await services.hooks.dispatchDynamicInstructions(ctx, emitted, messages);
  };

  const mode = ctx.require(ModeKey);
  let outcome: GenerateOutcome;
  try {
    throwIfTurnAborted(services.cancellation.abortSignal);
    outcome = await services.scope.run(ctx, session, async (enriched) => {
      let prepared = enriched;
      if (resolved?.outputSchema !== undefined) {
        prepared = { ...prepared, outputSchema: resolved.outputSchema };
      } else if (
        mode === "task" &&
        prepared.outputSchema === undefined &&
        restored.agentOutputSchema !== undefined
      ) {
        prepared = { ...prepared, outputSchema: restored.agentOutputSchema };
      }

      if (completions !== undefined) {
        const emissionState = getHarnessEmissionState(prepared.state);
        for (const completion of completions) {
          await handleEvent(
            createAuthorizationCompletedEvent({
              authorization: completion.authorization,
              name: completion.name,
              outcome: "authorized",
              sequence: emissionState.sequence,
              stepIndex: emissionState.stepIndex,
              turnId: emissionState.turnId,
            }),
          );
        }
      }

      return await services.generate({
        ctx,
        handleEvent,
        input: resolved,
        session: services.sessions.refresh(ctx, prepared),
      });
    });
  } catch (error) {
    if (!isTurnCancellation(error)) {
      throw error;
    }
    services.stream.release(writer);
    return {
      action: "cancelled",
      state: { durable: input.durableSnapshot, serializedContext: input.serializedContext },
    };
  }

  const rekeyed = reconcileSessionContinuationToken(ctx, outcome.state);
  const projected: ProjectedState = {
    durable: createDurableSessionState({ session: rekeyed }),
    serializedContext: services.codec.serialize(ctx),
  };

  if (outcome.action === "done") {
    await services.stream.close(writer);
    const totals = getTurnUsageState(rekeyed.state)?.session;
    return {
      action: "done",
      isError: outcome.isError,
      output: outcome.output,
      state: projected,
      usage: totals === undefined ? undefined : toUsage(totals),
    };
  }

  services.stream.release(writer);
  return withOutcomeState<EntryLoopTypes>(outcome, projected);
}

function readAuthorizationCallback(
  payload: DeliverPayload,
): AuthorizationCallbackPayload | undefined {
  // The callback route owns protocol parsing. DeliverPayload's extension
  // index erases that field's type before it reaches this internal hop.
  return payload["authorizationCallback"] as AuthorizationCallbackPayload | undefined;
}
