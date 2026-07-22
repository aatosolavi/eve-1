import { afterEach, describe, expect, it } from "vitest";

import {
  EVE_TRACE_RECORD_INPUTS_ENV,
  EVE_TRACE_RECORD_OUTPUTS_ENV,
  recordDefaultFromEnv,
} from "#harness/local-dev-tracing.js";

describe("recordDefaultFromEnv", () => {
  afterEach(() => {
    delete process.env[EVE_TRACE_RECORD_INPUTS_ENV];
    delete process.env[EVE_TRACE_RECORD_OUTPUTS_ENV];
  });

  it("defaults to true when the var is unset", () => {
    expect(recordDefaultFromEnv(EVE_TRACE_RECORD_INPUTS_ENV)).toBe(true);
  });

  it("keeps capture on for any value other than 0/false", () => {
    for (const value of ["1", "true", "yes", "on", ""]) {
      process.env[EVE_TRACE_RECORD_INPUTS_ENV] = value;
      expect(recordDefaultFromEnv(EVE_TRACE_RECORD_INPUTS_ENV)).toBe(true);
    }
  });

  it("suppresses capture when explicitly set to 0 or false, case-insensitively", () => {
    for (const value of ["0", "false", "FALSE", " False "]) {
      process.env[EVE_TRACE_RECORD_OUTPUTS_ENV] = value;
      expect(recordDefaultFromEnv(EVE_TRACE_RECORD_OUTPUTS_ENV)).toBe(false);
    }
  });
});
