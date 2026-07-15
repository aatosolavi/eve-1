import type { TurnSteeringPayload } from "#execution/turn-control-protocol.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/** Forwards one accepted public delivery to an active turn's steering inbox. */
export async function forwardTurnSteeringStep(input: {
  readonly payload: TurnSteeringPayload;
  readonly steeringToken: string;
}): Promise<void> {
  "use step";

  await resumeHook(input.steeringToken, input.payload);
}
