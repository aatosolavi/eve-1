import type { StepInput } from "#harness/types.js";

export type CompactStepInput = StepInput & { readonly messageConsumed?: boolean };

/** Removes empty optional fields before a step input is durably deferred. */
export function compactStepInput(input: CompactStepInput | undefined): CompactStepInput {
  if (input === undefined) return {};

  const result: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
    messageConsumed?: boolean;
    outputSchema?: StepInput["outputSchema"];
    steering?: true;
  } = {};

  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if ((input.inputResponses?.length ?? 0) > 0) result.inputResponses = input.inputResponses;
  if (input.message !== undefined) result.message = input.message;
  if (input.messageConsumed === true) result.messageConsumed = true;
  if (input.outputSchema !== undefined) result.outputSchema = input.outputSchema;
  if (input.steering === true) result.steering = true;

  return result;
}
