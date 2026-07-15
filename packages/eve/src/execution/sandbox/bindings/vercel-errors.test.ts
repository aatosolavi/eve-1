import { describe, expect, it } from "vitest";

import {
  isVercelSandboxMissingError,
  isVercelSnapshotUnavailableError,
  isVercelSnapshottingError,
} from "#execution/sandbox/bindings/vercel-errors.js";

function snapshottingError(overrides?: { status?: number; code?: string }): Error {
  return Object.assign(new Error("Status code 422 is not ok"), {
    json: { error: { code: overrides?.code ?? "sandbox_snapshotting" } },
    response: { status: overrides?.status ?? 422 },
  });
}

describe("isVercelSnapshottingError", () => {
  it("matches a 422 sandbox_snapshotting response", () => {
    expect(isVercelSnapshottingError(snapshottingError())).toBe(true);
  });

  it("matches when the SDK error is wrapped as a cause", () => {
    const wrapped = new Error("Failed to look up Vercel sandbox", {
      cause: snapshottingError(),
    });
    expect(isVercelSnapshottingError(wrapped)).toBe(true);
  });

  it("reads the status from a top-level statusCode too", () => {
    const error = Object.assign(new Error("nope"), {
      json: { error: { code: "sandbox_snapshotting" } },
      statusCode: 422,
    });
    expect(isVercelSnapshottingError(error)).toBe(true);
  });

  it("does not match a 422 with a different error code", () => {
    expect(isVercelSnapshottingError(snapshottingError({ code: "bad_request" }))).toBe(false);
  });

  it("does not match the snapshotting code on a non-422 status", () => {
    expect(isVercelSnapshottingError(snapshottingError({ status: 500 }))).toBe(false);
  });

  it("does not misclassify the missing/unavailable statuses it does not own", () => {
    const gone = Object.assign(new Error("gone"), { response: { status: 410 } });
    const missing = Object.assign(new Error("missing"), { response: { status: 404 } });
    expect(isVercelSnapshottingError(gone)).toBe(false);
    expect(isVercelSnapshottingError(missing)).toBe(false);
    expect(isVercelSnapshotUnavailableError(gone)).toBe(true);
    expect(isVercelSandboxMissingError(missing)).toBe(true);
  });
});
