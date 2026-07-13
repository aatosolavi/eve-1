import { defineAgent } from "eve";

export default defineAgent({
  limits: {
    maxSubagents: 2,
  },
  model: "openai/gpt-5.6-sol",
  reasoning: "high",
});
