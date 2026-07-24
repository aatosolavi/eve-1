import { describe, expect, it } from "vitest";

import {
  addLiveTask,
  getLiveTasks,
  hasLiveTasks,
  removeLiveTask,
  removeLiveTaskFromState,
} from "#harness/task-state.js";
import type { HarnessSession } from "#harness/types.js";

function createSession(state?: Record<string, unknown>): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
    state,
  };
}

describe("live-task index", () => {
  it("starts empty", () => {
    const session = createSession();
    expect(getLiveTasks(session.state).size).toBe(0);
    expect(hasLiveTasks(session.state)).toBe(false);
  });

  it("adds and removes tasks", () => {
    let session = addLiveTask(createSession(), { taskId: "task_a", taskRunId: "run_1" });
    session = addLiveTask(session, { taskId: "task_b", taskRunId: "run_2" });

    expect(getLiveTasks(session.state).get("task_a")).toBe("run_1");
    expect(getLiveTasks(session.state).get("task_b")).toBe("run_2");
    expect(hasLiveTasks(session.state)).toBe(true);

    session = removeLiveTask(session, "task_a");
    expect([...getLiveTasks(session.state).keys()]).toEqual(["task_b"]);
  });

  it("is idempotent on duplicate adds and missing removes", () => {
    const added = addLiveTask(createSession(), { taskId: "task_a", taskRunId: "run_1" });
    expect(addLiveTask(added, { taskId: "task_a", taskRunId: "run_1" })).toBe(added);

    const untouched = removeLiveTask(added, "task_missing");
    expect(untouched).toBe(added);
  });

  it("elides the state key when the last task is removed", () => {
    const session = removeLiveTask(
      addLiveTask(createSession(), { taskId: "task_a", taskRunId: "run_1" }),
      "task_a",
    );
    expect(session.state).toBeUndefined();
    expect(hasLiveTasks(session.state)).toBe(false);
  });

  it("preserves unrelated state entries", () => {
    const session = addLiveTask(createSession({ "eve.other": 1 }), {
      taskId: "task_a",
      taskRunId: "run_1",
    });
    const cleared = removeLiveTask(session, "task_a");
    expect(cleared.state).toEqual({ "eve.other": 1 });
  });

  it("removes at the state level, preserving unrelated keys and eliding when empty", () => {
    const session = addLiveTask(createSession({ "eve.other": 1 }), {
      taskId: "task_a",
      taskRunId: "run_1",
    });

    const untouched = removeLiveTaskFromState(session.state, "task_missing");
    expect(untouched).toBe(session.state);

    const cleared = removeLiveTaskFromState(session.state, "task_a");
    expect(cleared).toEqual({ "eve.other": 1 });
    expect(
      removeLiveTaskFromState({ "eve.runtime.liveTasks": { task_a: "run_1" } }, "task_a"),
    ).toBe(undefined);
  });

  it("ignores malformed stored values", () => {
    const session = createSession({ "eve.runtime.liveTasks": ["task_a"] });
    expect(getLiveTasks(session.state).size).toBe(0);
    expect(hasLiveTasks(session.state)).toBe(false);
  });
});
