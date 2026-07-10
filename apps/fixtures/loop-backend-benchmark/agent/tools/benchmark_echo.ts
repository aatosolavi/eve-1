import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: never(),
  description: "Return the deterministic verification string for a benchmark nonce.",
  inputSchema: z.object({
    nonce: z.string().describe("The nonce from the user message, copied exactly."),
  }),
  execute({ nonce }) {
    return `benchmark-verified:${nonce}`;
  },
});
