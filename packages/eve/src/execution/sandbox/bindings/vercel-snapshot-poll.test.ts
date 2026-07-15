import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureWithConcurrentSnapshotPolling } from "#execution/sandbox/bindings/vercel-snapshot-poll.js";

function snapshottingError(): Error {
  return Object.assign(new Error("Status code 422 is not ok"), {
    json: { error: { code: "sandbox_snapshotting" } },
    response: { status: 422 },
  });
}

async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const settled = Promise.allSettled([promise]);
  await vi.runAllTimersAsync();
  return (await settled)[0]!;
}

describe("ensureWithConcurrentSnapshotPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the attempt result once the snapshot finishes", async () => {
    let remaining = 2;
    const attempt = vi.fn().mockImplementation(async () => {
      if (remaining > 0) {
        remaining -= 1;
        throw snapshottingError();
      }
      return "ready";
    });

    const result = await settle(
      ensureWithConcurrentSnapshotPolling({ attempt, templateKey: "tpl" }),
    );

    expect(result).toMatchObject({ status: "fulfilled", value: "ready" });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("propagates a non-snapshotting error immediately without polling", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("boom"));

    const result = await settle(
      ensureWithConcurrentSnapshotPolling({ attempt, templateKey: "tpl" }),
    );

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({ message: "boom" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("gives up after the deadline with a message naming the template", async () => {
    const attempt = vi.fn().mockRejectedValue(snapshottingError());

    const result = await settle(
      ensureWithConcurrentSnapshotPolling({ attempt, templateKey: "tpl-key" }),
    );

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/sandbox template "tpl-key".*did not finish in time/),
    });
    // Polled repeatedly across the deadline rather than failing on the first 422.
    expect(attempt.mock.calls.length).toBeGreaterThan(10);
  });
});
