import { executeToolOperationId, generateOperationId } from "./effect-definitions.js";
import type {
  ApprovalRequest,
  GenerateInput,
  GeneratedTurn,
  OperationId,
  RequestResult,
  ToolRequest,
  TurnDependencies,
} from "./types.js";

export async function generate(
  dependencies: TurnDependencies,
  input: GenerateInput,
): Promise<{ readonly operationId: OperationId; readonly output: GeneratedTurn }> {
  return {
    operationId: generateOperationId(input),
    output: await dependencies.generate(input),
  };
}

export async function executeTool(
  dependencies: TurnDependencies,
  request: ApprovalRequest | ToolRequest,
): Promise<{ readonly operationId: OperationId; readonly output: RequestResult }> {
  return {
    operationId: executeToolOperationId(request),
    output: await dependencies.executeTool(request),
  };
}
