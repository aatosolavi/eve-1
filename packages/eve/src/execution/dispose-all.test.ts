import { describe, expect, it, vi } from "vitest";

import { disposeAll } from "#execution/dispose-all.js";

describe("disposeAll", () => {
  it("attempts every disposer and preserves the first failure", async () => {
    const firstFailure = new Error("turn control disposal failed");
    const laterFailure = new Error("delivery disposal failed");
    const calls: string[] = [];
    const continuationMarkersDispose = vi.fn(async () => {
      calls.push("session-continuation-marker");
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
        continuationMarkersDispose,
        authDispose,
      ]),
    ).rejects.toBe(firstFailure);

    expect(calls).toEqual(["turn-control", "delivery", "session-continuation-marker", "auth"]);
    expect(continuationMarkersDispose).toHaveBeenCalledOnce();
    expect(authDispose).toHaveBeenCalledOnce();
  });
});
