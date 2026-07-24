import { defineBashTool, defineTool, disableTool } from "#public/tools/index.js";

/**
 * Epoch 2 added the sandboxed default-tool authoring helpers
 * (`defineBashTool` et al.) and conditional authoring via `disableTool`.
 */
export const shell = defineBashTool({ description: "Run a shell command in the sandbox." });

export default process.env.EVE_DISABLE_ECHO
  ? disableTool()
  : defineTool({
      description: "Echo the caller-provided note back to the model.",
      inputSchema: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
      },
      async execute(input, ctx) {
        return { note: (input as { note: string }).note, sessionId: ctx.session.id };
      },
    });
