import { z } from "#compiled/zod/index.js";

/**
 * Background-election input carried on a tool call.
 *
 * Presence of the `task` field on a call elects background execution;
 * the shape mirrors the MCP tasks extension's request-side augmentation
 * (`ttlMs` is the only negotiable field today, `null` = unlimited
 * retention).
 */
export type TaskElection = z.infer<typeof taskElectionSchema>;

/**
 * Zod schema for the `task` election field on a tool call.
 */
export const taskElectionSchema = z
  .object({
    ttlMs: z.number().nullable().optional(),
  })
  .strict();

const INTERNAL_TASK_ELECTION_ENV = "EVE_INTERNAL_BACKGROUND_TASK_ELECTION";

/**
 * Internal Slice 1 gate: enables background election on the built-in
 * `agent` tool (`taskSupport: "optional"` plus the `task` input field).
 * Exists only so integration coverage can exercise the creation path
 * before any public elector ships — the Slice 2 `task:` combinators
 * replace it. Never document or rely on it.
 */
export function isInternalBackgroundTaskElectionEnabled(): boolean {
  return process.env[INTERNAL_TASK_ELECTION_ENV] === "1";
}

/**
 * Normalizes one recorded background election (`ttlMs` defaulted to
 * `null`), or `undefined` when the call carried none. Elections are
 * recorded per `callId` on the pending runtime-action batch
 * (`PendingRuntimeActionBatch.taskElections`) — never on the action
 * request, whose type is part of the extension capability contracts.
 * This is the single seam later slices extend: subagent combinators
 * (Slice 2) and authored-tool `task:` declarations (Slice 3) both
 * surface elections through this reader.
 */
export function readBackgroundElection(
  election: TaskElection | undefined,
): { readonly ttlMs: number | null } | undefined {
  if (election === undefined) {
    return undefined;
  }
  return { ttlMs: election.ttlMs ?? null };
}
