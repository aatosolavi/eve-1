import { stringifyCanonical } from "./wire.js";
import type { ExecutionId, SessionCheckpoint, SessionState } from "./types.js";

export function initialCheckpoint(owner: ExecutionId, state: SessionState): SessionCheckpoint {
  return { leaseOwner: owner, revision: 0, state, version: 1 };
}

export function checkpointOwnedState(
  previous: SessionCheckpoint,
  owner: ExecutionId,
  state: SessionState,
): SessionCheckpoint {
  if (previous.leaseOwner !== owner) {
    throw new Error(`Checkpoint lease belongs to "${previous.leaseOwner}", not "${owner}".`);
  }
  return {
    leaseOwner: owner,
    revision: previous.revision + 1,
    state,
    version: previous.version,
  };
}

export function delegateCheckpoint(
  previous: SessionCheckpoint,
  parent: ExecutionId,
  child: ExecutionId,
): SessionCheckpoint {
  if (previous.leaseOwner !== parent) {
    throw new Error(`Checkpoint lease belongs to "${previous.leaseOwner}", not "${parent}".`);
  }
  return {
    leaseOwner: child,
    revision: previous.revision + 1,
    state: previous.state,
    version: previous.version,
  };
}

export class TurnCheckpointProtocol {
  readonly #child: ExecutionId;
  readonly #parent: ExecutionId;
  readonly #persist: (checkpoint: SessionCheckpoint) => Promise<void>;
  #lastAcknowledged: SessionCheckpoint | null = null;
  #latest: SessionCheckpoint;

  constructor(input: {
    readonly child: ExecutionId;
    readonly delegated: SessionCheckpoint;
    readonly parent: ExecutionId;
    readonly persist: (checkpoint: SessionCheckpoint) => Promise<void>;
  }) {
    if (input.delegated.leaseOwner !== input.child) {
      throw new Error(`Delegated checkpoint does not belong to child "${input.child}".`);
    }
    this.#child = input.child;
    this.#latest = input.delegated;
    this.#parent = input.parent;
    this.#persist = input.persist;
  }

  async accept(next: SessionCheckpoint): Promise<number> {
    if (next.revision === this.#latest.revision) {
      if (stringifyCanonical(next) !== stringifyCanonical(this.#latest)) {
        throw new Error("Child redelivered a checkpoint revision with different bytes.");
      }
      return next.revision;
    }

    this.#validateNext(next);
    await this.#persist(next);
    this.#latest = next;
    this.#lastAcknowledged = next;
    return next.revision;
  }

  async complete(state: SessionState): Promise<SessionCheckpoint> {
    if (
      this.#lastAcknowledged === null ||
      stringifyCanonical(state) !== stringifyCanonical(this.#lastAcknowledged.state)
    ) {
      throw new Error("Turn terminal state does not match the last acknowledged checkpoint.");
    }
    const returned: SessionCheckpoint = {
      leaseOwner: this.#parent,
      revision: this.#lastAcknowledged.revision + 1,
      state,
      version: this.#lastAcknowledged.version,
    };
    await this.#persist(returned);
    this.#latest = returned;
    return returned;
  }

  #validateNext(next: SessionCheckpoint): void {
    const previous = this.#latest;
    if (previous.leaseOwner !== this.#child) {
      throw new Error("Child reported an update after returning checkpoint ownership.");
    }
    if (next.revision <= previous.revision) {
      throw new Error("Child reported a non-monotonic checkpoint revision.");
    }
    if (next.version !== previous.version) {
      throw new Error("Child changed the checkpoint version.");
    }
    if (next.leaseOwner !== this.#child) {
      throw new Error("Child assigned checkpoint ownership to another execution.");
    }

    const prior = previous.state;
    const state = next.state;
    if (
      state.sessionId !== prior.sessionId ||
      state.mode !== prior.mode ||
      state.nextTurnOrdinal !== prior.nextTurnOrdinal ||
      stringifyCanonical(state.scenario) !== stringifyCanonical(prior.scenario) ||
      stringifyCanonical(state.bufferedDeliveries) !== stringifyCanonical(prior.bufferedDeliveries)
    ) {
      throw new Error("Child changed parent-owned session identity.");
    }
  }
}
