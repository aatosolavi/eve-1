import { generateStep } from "#core/turn-call.js";
import { createStepServices } from "#harness/step-services.js";
import type { GenerateConfig, GenerateFn } from "#core/step-types.js";

/** Creates the production generate function for one harness configuration. */
export function createGenerate(config: GenerateConfig): GenerateFn {
  const services = createStepServices(config);
  return (state, input) => generateStep({ config, input, services, state });
}
