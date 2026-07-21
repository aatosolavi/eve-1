import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";

const invocationCount = defineState("compaction-regression.emit-oversized-output", () => 0);

// Large relative to the fixture's per-step tool budget (the degenerate-guard
// 2,000 tokens ≈ 8,000 chars), so the harness must truncate it at attach time.
// The tail sentinel sits past every truncation cut, so it is only ever
// observable by retrieving the full output from the session stream.
const OVERSIZED_PAYLOAD = `${"oversized step output padding ".repeat(1_000)}OVERSIZED_PAYLOAD_TAIL_SENTINEL`;

export default defineTool({
  description:
    "Compaction regression tool. Returns output larger than the per-step tool budget so the harness truncation is observable.",
  inputSchema: z.object({}),
  async execute() {
    const attempt = invocationCount.get() + 1;
    invocationCount.update(() => attempt);

    return {
      attempt,
      completed: true,
      payload: OVERSIZED_PAYLOAD,
    };
  },
});
