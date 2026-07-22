import { describe, expect, it } from "vitest";

import { toObservableUserIdentity } from "#runtime/sessions/observable-user.js";

describe("toObservableUserIdentity", () => {
  it("projects only the stable user id", () => {
    expect(
      toObservableUserIdentity({
        attributes: { email: "ada@example.com" },
        authenticator: "slack-webhook",
        issuer: "slack:T1",
        principalId: "slack:T1:U1",
        principalType: "user",
      }),
    ).toEqual({ id: "slack:T1:U1" });
  });

  it("omits non-user and missing identities", () => {
    expect(toObservableUserIdentity(null)).toBeUndefined();
    expect(
      toObservableUserIdentity({
        attributes: {},
        authenticator: "app",
        principalId: "eve:app",
        principalType: "runtime",
      }),
    ).toBeUndefined();
  });
});
