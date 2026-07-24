import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import {
  getAuthorizationResult,
  getHookUrl,
  isAuthorizationSignal,
  requestAuthorization,
} from "#public/tools/index.js";

describe("eve/tools authorization exports", () => {
  it("builds a signal that the harness type guard recognizes", () => {
    const signal = requestAuthorization([
      {
        name: "probe",
        challenge: { url: "https://idp.example/authorize", instructions: "Sign in." },
        hookUrl: "https://agent.example/eve/v1/connections/probe/callback/session%3Aauth",
      },
    ]);

    expect(isAuthorizationSignal(signal)).toBe(true);
    expect(signal.challenges).toHaveLength(1);
    expect(signal.challenges[0]?.name).toBe("probe");
    expect(isAuthorizationSignal({ challenges: [] })).toBe(false);
  });

  it("builds hook URLs and reads results inside a session context", () => {
    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "session-1");
    ctx.set(CallbackBaseUrlKey, "https://agent.example");

    contextStorage.run(ctx, () => {
      expect(getHookUrl("probe")).toBe(
        "https://agent.example/eve/v1/connections/probe/callback/session-1%3Aauth",
      );
      expect(getAuthorizationResult("probe")).toBeUndefined();
    });
  });
});
