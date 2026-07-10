import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

const BENCHMARK_TOOL_NAME = "benchmark_echo";

type DeterministicBenchmarkRequest = Pick<
  MockModelRequest,
  "lastUserMessage" | "toolResults" | "tools"
>;

export const deterministicBenchmarkModel = mockModel({
  modelId: "loop-backend-benchmark",
  provider: "eve-loop-benchmark",
  respond: createDeterministicBenchmarkResponse,
});

export function createDeterministicBenchmarkResponse(
  request: DeterministicBenchmarkRequest,
): MockModelResponse | string {
  if (request.toolResults.length === 0) {
    if (request.lastUserMessage === null) {
      throw new Error("The deterministic benchmark model expected one user nonce.");
    }
    if (!request.tools.some((tool) => tool.name === BENCHMARK_TOOL_NAME)) {
      throw new Error(
        `The deterministic benchmark model requires the ${BENCHMARK_TOOL_NAME} tool.`,
      );
    }

    return {
      toolCalls: [
        {
          id: "benchmark-echo-call",
          input: { nonce: request.lastUserMessage },
          name: BENCHMARK_TOOL_NAME,
        },
      ],
    };
  }

  if (request.toolResults.length !== 1) {
    throw new Error("The deterministic benchmark model expected exactly one tool result.");
  }

  const result = request.toolResults[0];
  if (result === undefined || result.name !== BENCHMARK_TOOL_NAME) {
    throw new Error(`The deterministic benchmark model expected a ${BENCHMARK_TOOL_NAME} result.`);
  }
  if (result.isError) {
    throw new Error(
      `The deterministic benchmark model received a failed ${BENCHMARK_TOOL_NAME} result.`,
    );
  }
  if (typeof result.output !== "string") {
    throw new Error(
      `The deterministic benchmark model expected a text ${BENCHMARK_TOOL_NAME} result.`,
    );
  }

  return result.output;
}
