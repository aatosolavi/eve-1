import { describe, expect, it, vi } from "vitest";

import { disposeAll } from "#execution/dispose-all.js";

describe("disposeAll", () => {
  it("attempts every disposer and preserves the first failure", async () => {
    const firstFailure = new Error("turn control disposal failed");
    const laterFailure = new Error("delivery disposal failed");
    const calls: string[] = [];
    const continuationStateDispose = vi.fn(async () => {
      calls.push("continuation-state");
    });
    const authDispose = vi.fn(async () => {
      calls.push("auth");
    });

    await expect(
      disposeAll([
        async () => {
          calls.push("turn-control");
          throw firstFailure;
        },
        async () => {
          calls.push("delivery");
          throw laterFailure;
        },
        continuationStateDispose,
        authDispose,
      ]),
    ).rejects.toBe(firstFailure);

    expect(calls).toEqual(["turn-control", "delivery", "continuation-state", "auth"]);
    expect(continuationStateDispose).toHaveBeenCalledOnce();
    expect(authDispose).toHaveBeenCalledOnce();
  });
});
