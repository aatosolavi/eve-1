import { describe, expect, it } from "vitest";

import { startupStatusForBootPhase } from "./startup-status.js";

describe("startupStatusForBootPhase", () => {
  it("gives connection its own headline", () => {
    expect(startupStatusForBootPhase("connecting to agent")).toEqual({
      kind: "working",
      label: "Connecting to agent",
    });
  });

  it("gives active-run recovery its own headline", () => {
    expect(startupStatusForBootPhase("recovering active runs")).toEqual({
      kind: "working",
      label: "Recovering active runs",
    });
  });

  it("collapses build phases under one headline with the phase as detail", () => {
    expect(startupStatusForBootPhase("compiling agent")).toEqual({
      kind: "working",
      label: "Building your agent",
      detail: "compiling agent",
    });
  });
});
