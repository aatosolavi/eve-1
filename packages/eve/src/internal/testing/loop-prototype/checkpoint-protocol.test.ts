import { describe, expect, it } from "vitest";

import {
  checkpointOwnedState,
  delegateCheckpoint,
  initialCheckpoint,
  TurnCheckpointProtocol,
} from "./checkpoint-protocol.js";
import { executionId, sessionId } from "./ids.js";
import { emptyHistory } from "./transcript.js";
import type { SessionCheckpoint, SessionState } from "./types.js";

describe("turn checkpoint protocol", () => {
  it("requires terminal state to match an acknowledged checkpoint", async () => {
    const { protocol } = createProtocol();

    await expect(protocol.complete(state())).rejects.toThrow(
      "does not match the last acknowledged checkpoint",
    );
  });

  it("rejects changes to parent-owned session identity", async () => {
    const { child, delegated, protocol } = createProtocol();
    const changed = checkpointOwnedState(delegated, child, {
      ...delegated.state,
      sessionId: sessionId("other"),
    });

    await expect(protocol.accept(changed)).rejects.toThrow("changed parent-owned session identity");
  });

  it("re-acknowledges an exact duplicate without persisting it twice", async () => {
    const { child, delegated, persisted, protocol } = createProtocol();
    const update = checkpointOwnedState(delegated, child, delegated.state);

    await expect(protocol.accept(update)).resolves.toBe(update.revision);
    await expect(protocol.accept(update)).resolves.toBe(update.revision);
    expect(persisted).toEqual([update]);
  });

  it("accepts distinct child-owned revisions before lease return", async () => {
    const { child, delegated, persisted, protocol } = createProtocol();
    const first = checkpointOwnedState(delegated, child, {
      ...delegated.state,
      history: emptyHistory(),
    });
    const second = checkpointOwnedState(first, child, { ...first.state, phase: "terminal" });

    await protocol.accept(first);
    await protocol.accept(second);
    await expect(protocol.complete(second.state)).resolves.toMatchObject({
      leaseOwner: parentExecution,
    });
    expect(persisted).toHaveLength(3);
  });

  it("rejects changed bytes for a redelivered revision", async () => {
    const { child, delegated, protocol } = createProtocol();
    const update = checkpointOwnedState(delegated, child, delegated.state);
    await protocol.accept(update);

    await expect(
      protocol.accept({ ...update, state: { ...update.state, phase: "terminal" } }),
    ).rejects.toThrow("different bytes");
  });

  it("rejects another update after returning the lease", async () => {
    const { child, delegated, protocol } = createProtocol();
    const update = checkpointOwnedState(delegated, child, delegated.state);
    await protocol.accept(update);
    const returned = await protocol.complete(update.state);
    const postReturn: SessionCheckpoint = {
      ...returned,
      leaseOwner: child,
      revision: returned.revision + 1,
    };

    await expect(protocol.accept(postReturn)).rejects.toThrow(
      "after returning checkpoint ownership",
    );
  });
});

const parentExecution = executionId("protocol:parent");
const childExecution = executionId("protocol:child");

function createProtocol(): {
  readonly child: typeof childExecution;
  readonly delegated: SessionCheckpoint;
  readonly persisted: SessionCheckpoint[];
  readonly protocol: TurnCheckpointProtocol;
} {
  const delegated = delegateCheckpoint(
    initialCheckpoint(parentExecution, state()),
    parentExecution,
    childExecution,
  );
  const persisted: SessionCheckpoint[] = [];
  return {
    child: childExecution,
    delegated,
    persisted,
    protocol: new TurnCheckpointProtocol({
      child: childExecution,
      delegated,
      parent: parentExecution,
      persist: (checkpoint) => {
        persisted.push(checkpoint);
        return Promise.resolve();
      },
    }),
  };
}

function state(): SessionState {
  return {
    bufferedDeliveries: [],
    history: emptyHistory(),
    mode: "task",
    nextTurnOrdinal: 1,
    pending: null,
    phase: "turn",
    scenario: { kind: "echo" },
    sessionId: sessionId("protocol"),
  };
}
