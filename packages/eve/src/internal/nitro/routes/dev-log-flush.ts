import { timingSafeEqualStrings } from "#internal/nitro/dev-client-address.js";
import { flushDevelopmentLogs } from "#internal/dev-logs/client.js";
import {
  DEVELOPMENT_WORKFLOW_SECRET_ENV,
  DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER,
} from "#internal/workflow/development-world-protocol.js";

/** Flushes worker-buffered output to the parent before a development reload. */
export async function handleDevLogFlushRequest(request: Request): Promise<Response> {
  const expectedSecret = process.env[DEVELOPMENT_WORKFLOW_SECRET_ENV];
  const receivedSecret = request.headers.get(DEVELOPMENT_WORKFLOW_TRANSPORT_HEADER);
  if (
    expectedSecret === undefined ||
    receivedSecret === null ||
    !timingSafeEqualStrings(receivedSecret, expectedSecret)
  ) {
    return Response.json(
      { error: "Development log flush request is not trusted." },
      { status: 401 },
    );
  }
  await flushDevelopmentLogs();
  return new Response(null, { status: 204 });
}
