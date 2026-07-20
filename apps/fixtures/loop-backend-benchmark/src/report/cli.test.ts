import { describe, expect, it } from "vitest";

import { parseReportArguments } from "./cli.js";

describe("parseReportArguments", () => {
  it("accepts multiple JSONL inputs and an explicit output", () => {
    expect(
      parseReportArguments(["local.jsonl", "--output", "comparison.html", "vercel.jsonl"]),
    ).toEqual({
      inputPaths: ["local.jsonl", "vercel.jsonl"],
      kind: "render",
      output: { kind: "file", path: "comparison.html" },
    });
  });

  it("writes to stdout by default", () => {
    expect(parseReportArguments(["--", "results.jsonl"])).toEqual({
      inputPaths: ["results.jsonl"],
      kind: "render",
      output: { kind: "stdout" },
    });
  });

  it("returns help without requiring an input", () => {
    expect(parseReportArguments(["--help"])).toEqual({ kind: "help" });
  });

  it.each([
    [[], "Expected at least one benchmark JSONL input path"],
    [["--output"], 'Missing value for "--output"'],
    [["--wat"], 'Unknown argument "--wat"'],
  ])("rejects invalid arguments", (argv, message) => {
    expect(() => parseReportArguments(argv)).toThrow(message);
  });
});
