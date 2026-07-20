import { describe, expect, it } from "vitest";

import { parseLoopBenchmarkDeliveryMessage } from "./delivery-message.js";

describe("parseLoopBenchmarkDeliveryMessage", () => {
  it("accepts the plain-text payload shape materialized by channel.send", () => {
    expect(
      parseLoopBenchmarkDeliveryMessage(
        {
          continuationToken: "benchmark-token",
          payload: {
            context: undefined,
            inputResponses: undefined,
            message: "again",
            outputSchema: undefined,
          },
        },
        "Workflow",
      ),
    ).toBe("again");
  });

  it("rejects defined non-message input", () => {
    expect(() =>
      parseLoopBenchmarkDeliveryMessage(
        {
          continuationToken: "benchmark-token",
          payload: { context: ["hidden"], message: "again" },
        },
        "Temporal",
      ),
    ).toThrow("Temporal benchmark only supports plain-text follow-up deliveries.");
  });
});
