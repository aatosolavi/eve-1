import { executeToolOperationId, generateOperationId } from "./effect-definitions.js";
import type {
  ApprovalRequest,
  GenerateInput,
  GeneratedTurn,
  LoopBackend,
  OperationId,
  RequestResult,
  ToolRequest,
} from "./types.js";

export async function generate(
  backend: LoopBackend,
  input: GenerateInput,
): Promise<{ readonly operationId: OperationId; readonly output: GeneratedTurn }> {
  return {
    operationId: generateOperationId(input),
    output: await backend.generate(input),
  };
}

export async function executeTool(
  backend: LoopBackend,
  request: ApprovalRequest | ToolRequest,
): Promise<{ readonly operationId: OperationId; readonly output: RequestResult }> {
  return {
    operationId: executeToolOperationId(request),
    output: await backend.executeTool(request),
  };
}
