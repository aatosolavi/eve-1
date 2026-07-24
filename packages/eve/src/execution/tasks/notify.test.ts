import { afterEach, describe, expect, it, vi } from "vitest";

import { notifyTaskEndpoints } from "#execution/tasks/notify.js";
import type { StoredNotificationEndpoint } from "#execution/tasks/store.js";
import type { TaskNotification } from "#runtime/tasks/types.js";

const notification: TaskNotification = {
  kind: "task.terminal",
  task: {
    createdAt: "2026-07-23T00:00:00.000Z",
    lastUpdatedAt: "2026-07-23T00:00:01.000Z",
    result: "done",
    status: "completed",
    taskId: "task_1",
    ttlMs: null,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string) => Response | Error): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string | URL | Request) => {
    const result = handler(String(url));
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("notifyTaskEndpoints", () => {
  it("POSTs the envelope to routed endpoints", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 202 }));

    const endpoints: StoredNotificationEndpoint[] = [{ url: "https://caller.example/cb/a" }];
    const result = await notifyTaskEndpoints({ endpoints, notification });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://caller.example/cb/a");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual(notification);
    expect(result).toEqual(endpoints);
  });

  it("skips dead endpoints and kinds outside the endpoint's routes", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 202 }));

    await notifyTaskEndpoints({
      endpoints: [
        { dead: true, url: "https://caller.example/cb/dead" },
        { routes: ["task.progress"], url: "https://caller.example/cb/progress-only" },
      ],
      notification,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not route task.created or task.progress by default", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 202 }));

    await notifyTaskEndpoints({
      endpoints: [{ url: "https://caller.example/cb/a" }],
      notification: {
        kind: "task.created",
        task: { ...notification.task, status: "working" } as TaskNotification["task"],
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks an endpoint dead on 404 without failing the batch", async () => {
    const fetchMock = stubFetch((url) =>
      url.endsWith("/gone")
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 202 }),
    );

    const result = await notifyTaskEndpoints({
      endpoints: [
        { url: "https://caller.example/cb/gone" },
        { url: "https://caller.example/cb/live" },
      ],
      notification,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result[0]).toEqual({ dead: true, url: "https://caller.example/cb/gone" });
    expect(result[1]).toEqual({ url: "https://caller.example/cb/live" });
  });

  it("drops on network failure and non-OK statuses without throwing or marking dead", async () => {
    stubFetch((url) =>
      url.endsWith("/down") ? new Error("connection refused") : new Response(null, { status: 500 }),
    );

    const endpoints: StoredNotificationEndpoint[] = [
      { url: "https://caller.example/cb/down" },
      { url: "https://caller.example/cb/error" },
    ];

    await expect(notifyTaskEndpoints({ endpoints, notification })).resolves.toEqual(endpoints);
  });
});
