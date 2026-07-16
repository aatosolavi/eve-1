import {
  DEVELOPMENT_LOG_ROUTE,
  developmentLogBatchSchema,
  type DevelopmentLogEvent,
} from "#internal/dev-logs/protocol.js";
import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";
import {
  decodeDevelopmentWorldValue,
  encodeDevelopmentWorldValue,
  serializeDevelopmentWorldError,
} from "#internal/workflow/development-world-codec.js";
import { DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER } from "#internal/workflow/development-world-protocol.js";

export async function handleDevelopmentLogRequest(input: {
  readonly log:
    | { appendOutputEvents(events: readonly DevelopmentLogEvent[]): Promise<void> }
    | undefined;
  readonly request: Request;
  readonly transportSecret: string;
}): Promise<Response | undefined> {
  if (new URL(input.request.url).pathname !== DEVELOPMENT_LOG_ROUTE) return undefined;
  const header = input.request.headers.get(DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER);
  if (
    input.request.method !== "POST" ||
    header === null ||
    !timingSafeEqualStrings(header, input.transportSecret)
  ) {
    return Response.json({ error: "Development log request is not trusted." }, { status: 401 });
  }
  if (input.log === undefined) return new Response(null, { status: 204 });

  try {
    const parsed = developmentLogBatchSchema.safeParse(
      decodeDevelopmentWorldValue(await input.request.text()),
    );
    if (!parsed.success) {
      return Response.json({ error: "Development log request is malformed." }, { status: 400 });
    }
    await input.log.appendOutputEvents(parsed.data.events);
    return new Response(null, { status: 204 });
  } catch (error) {
    return new Response(encodeDevelopmentWorldValue(serializeDevelopmentWorldError(error)), {
      status: 500,
    });
  }
}
