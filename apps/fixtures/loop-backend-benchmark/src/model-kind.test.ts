import { describe, expect, it } from "vitest";

import { parseBenchmarkModelKind } from "./model-kind.js";

describe("parseBenchmarkModelKind", () => {
  it("defaults an unset value to the deterministic model", () => {
    expect(parseBenchmarkModelKind(undefined)).toBe("deterministic");
  });

  it.each(["deterministic", "live"] as const)("accepts %s", (modelKind) => {
    expect(parseBenchmarkModelKind(modelKind)).toBe(modelKind);
  });

  it.each(["", "gateway", "LIVE", " deterministic "])("rejects %j", (value) => {
    expect(() => parseBenchmarkModelKind(value)).toThrow(
      `EVE_LOOP_BENCHMARK_MODEL_KIND must be "deterministic" or "live"; received ${JSON.stringify(value)}.`,
    );
  });
});
