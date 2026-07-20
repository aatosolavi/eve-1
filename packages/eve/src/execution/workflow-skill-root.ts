import type { ContextContainer } from "#context/container.js";
import type { RuntimeTurnAgent } from "#runtime/agent/bootstrap.js";

export async function resolveSessionSkillRoot(input: {
  readonly ctx: ContextContainer;
  readonly turnAgent: RuntimeTurnAgent;
}): Promise<string | undefined> {
  void input;
  // Authored skill metadata and instructions are already available on the
  // resolved turn agent. Resolving a filesystem path here would provision a
  // sandbox before the model call merely because the agent declares skills.
  return undefined;
}
