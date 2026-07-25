import type { InputRequest } from "#core/input/types.js";
import type { HarnessToolMap } from "#harness/types.js";

/**
 * Creates an approval-key resolver from the tool map. The resolver computes
 * compound keys at recording time instead of pre-computing and persisting
 * them on the pending batch.
 */
export function resolveApprovalKeyFromTools(
  tools: HarnessToolMap,
): (request: InputRequest) => string | undefined {
  return (request) => {
    const toolDef = tools.get(request.action.toolName);
    if (toolDef?.approvalKey === undefined) {
      return undefined;
    }
    return toolDef.approvalKey(request.action.input);
  };
}
