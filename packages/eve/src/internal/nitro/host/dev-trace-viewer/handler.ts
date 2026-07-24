import { projectRunSummary, projectWaterfall, TraceStore } from "#internal/tracing/index.js";
import {
  EVE_DEV_TRACES_DATA_ROUTE_PATH,
  EVE_DEV_TRACES_ROUTE_PATH,
  EVE_DEV_TRACES_STREAM_ROUTE_PATH,
} from "#protocol/routes.js";
import { getTraceWatcher } from "#internal/nitro/host/dev-trace-viewer/trace-watcher.js";
import { TRACE_VIEWER_HTML } from "#internal/nitro/host/dev-trace-viewer/viewer-html.js";

const JSON_HEADERS = { "cache-control": "no-store" } as const;

/**
 * A Server-Sent Events stream that emits a `change` event (`{ runId }`) whenever
 * a run's trace changes on disk, so the viewer refreshes live. Cleaned up when
 * the client disconnects (the request abort signal).
 */
function streamResponse(appRoot: string, signal: AbortSignal): Response {
  const watcher = getTraceWatcher(appRoot);
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed; ignore.
        }
      };
      const cleanup = (): void => {
        if (keepAlive !== undefined) clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      enqueue("event: ready\ndata: {}\n\n");
      unsubscribe = watcher.subscribe((runId) => {
        enqueue(`event: change\ndata: ${JSON.stringify({ runId })}\n\n`);
      });
      keepAlive = setInterval(() => enqueue(": ping\n\n"), 15_000);

      if (signal.aborted) cleanup();
      else signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      if (keepAlive !== undefined) clearInterval(keepAlive);
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      connection: "keep-alive",
    },
  });
}

function htmlResponse(): Response {
  return new Response(TRACE_VIEWER_HTML, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    },
  });
}

async function runsListResponse(appRoot: string): Promise<Response> {
  const runs = await new TraceStore(appRoot).list();
  return Response.json({ runs }, { headers: JSON_HEADERS });
}

async function runDetailResponse(appRoot: string, traceId: string): Promise<Response> {
  const spans = await new TraceStore(appRoot).read(traceId);
  if (spans === undefined || spans.length === 0) {
    return Response.json({ error: "Unknown trace." }, { status: 404, headers: JSON_HEADERS });
  }
  return Response.json(
    { summary: projectRunSummary(spans), waterfall: projectWaterfall(spans) },
    { headers: JSON_HEADERS },
  );
}

/**
 * Handles requests under the dev-only trace viewer namespace (`/__traces`).
 *
 * Serves the self-contained viewer SPA at `GET /__traces`, a live SSE feed at
 * `GET /__traces/stream`, the runs list at `GET /__traces/data`, and a single
 * run's summary + waterfall at `GET /__traces/data/<traceId>` (or `?traceId=`).
 * Returns `undefined` for anything else in the namespace so the caller can
 * fall through to the app.
 *
 * Auth: none. Mounted only by the local dev server; never present in
 * production builds.
 */
export async function handleDevTraceViewerRequest(input: {
  readonly appRoot: string;
  readonly request: Request;
}): Promise<Response | undefined> {
  const { appRoot, request } = input;
  if (request.method !== "GET") return undefined;

  const url = new URL(request.url);
  const { pathname } = url;

  if (pathname === EVE_DEV_TRACES_ROUTE_PATH) {
    return htmlResponse();
  }

  if (pathname === EVE_DEV_TRACES_STREAM_ROUTE_PATH) {
    return streamResponse(appRoot, request.signal);
  }

  if (pathname === EVE_DEV_TRACES_DATA_ROUTE_PATH) {
    const traceId = url.searchParams.get("traceId");
    return traceId !== null && traceId.length > 0
      ? runDetailResponse(appRoot, traceId)
      : runsListResponse(appRoot);
  }

  const dataPrefix = `${EVE_DEV_TRACES_DATA_ROUTE_PATH}/`;
  if (pathname.startsWith(dataPrefix)) {
    const traceId = decodeURIComponent(pathname.slice(dataPrefix.length));
    if (traceId.length > 0) {
      return runDetailResponse(appRoot, traceId);
    }
  }

  return undefined;
}
