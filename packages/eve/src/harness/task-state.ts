import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const LIVE_TASKS_KEY = "eve.runtime.liveTasks";

/**
 * Returns the session's live (non-terminal) background tasks as a
 * fresh `taskId → taskRunId` map. Never returns a live reference so
 * accidental mutation cannot corrupt session state.
 *
 * The index is a session-state pointer map only; task records
 * themselves are owned by their actor runs (`#execution/tasks/store.js`)
 * so they stay writable while the session is parked. Both index
 * writers — the dispatch step at election and the turn step at
 * terminal consumption — sit on the threaded session-state path. The
 * run id is store-internal and never appears on streams.
 */
export function getLiveTasks(state: SessionStateMap | undefined): ReadonlyMap<string, string> {
  return new Map(Object.entries(readMap(state)));
}

/**
 * Returns true when the session has at least one live background task.
 */
export function hasLiveTasks(state: SessionStateMap | undefined): boolean {
  for (const _ of Object.keys(readMap(state))) {
    return true;
  }
  return false;
}

/**
 * Adds a task to the live-task index. Idempotent per task id.
 */
export function addLiveTask(
  session: HarnessSession,
  entry: { readonly taskId: string; readonly taskRunId: string },
): HarnessSession {
  const current = readMap(session.state);
  if (current[entry.taskId] === entry.taskRunId) {
    return session;
  }
  return writeMap(session, { ...current, [entry.taskId]: entry.taskRunId });
}

/**
 * Removes a task from the live-task index. Called when a terminal
 * task notification is consumed. Idempotent.
 */
export function removeLiveTask(session: HarnessSession, taskId: string): HarnessSession {
  const state = removeLiveTaskFromState(session.state, taskId);
  return state === session.state ? session : { ...session, state };
}

/**
 * State-level form of {@link removeLiveTask} for callers holding a
 * `SessionStateMap` rather than a full session (e.g. the turn step
 * before hydration). Returns the same reference when nothing changed.
 */
export function removeLiveTaskFromState(
  state: SessionStateMap | undefined,
  taskId: string,
): SessionStateMap | undefined {
  const current = readMap(state);
  if (!(taskId in current)) {
    return state;
  }
  const next = { ...current };
  delete next[taskId];

  const nextState = { ...state };
  if (Object.keys(next).length === 0) {
    delete nextState[LIVE_TASKS_KEY];
    return Object.keys(nextState).length > 0 ? nextState : undefined;
  }
  nextState[LIVE_TASKS_KEY] = next;
  return nextState;
}

function readMap(state: SessionStateMap | undefined): Readonly<Record<string, string>> {
  const raw = state?.[LIVE_TASKS_KEY];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function writeMap(session: HarnessSession, entries: Record<string, string>): HarnessSession {
  const state = { ...session.state };

  if (Object.keys(entries).length === 0) {
    delete state[LIVE_TASKS_KEY];
    return {
      ...session,
      state: Object.keys(state).length > 0 ? state : undefined,
    };
  }

  state[LIVE_TASKS_KEY] = entries;
  return { ...session, state };
}
