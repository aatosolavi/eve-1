import type { DeliverPayload, SessionAuthContext } from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { payloadCarriesTaskNotifications } from "#execution/tasks/delivery.js";
import { routeProxiedDeliverStep } from "#execution/workflow-steps.js";

/**
 * Coalesces inbound deliver payloads and routes any descendant-bound input
 * responses down to the owning child and task notifications through the
 * task arms, returning the parent-local remainder (or `undefined` when the
 * whole payload routed away).
 *
 * Short-circuits when no descendant subagent is active and no task
 * notification is aboard so the common path skips a durable step boundary.
 * Lives in its own non-step module so both the driver and the active turn
 * can share it (a `"use step"` module cannot re-export plain helpers into
 * a workflow body).
 */
export async function routeDeliverToChildren(input: {
  readonly auth?: SessionAuthContext | null;
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly payloads: readonly DeliverPayload[];
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<DeliverPayload | undefined> {
  const payload = coalesceDeliverPayloads(input.payloads);
  if (!input.sessionState.hasProxyInputRequests && !payloadCarriesTaskNotifications(payload)) {
    return payload;
  }

  const routed = await routeProxiedDeliverStep({
    auth: input.auth,
    parentWritable: input.parentWritable,
    payload,
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  return routed.remainder;
}
