import type { LookupFunction } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestPublicUrl } from "#execution/web-fetch/request.js";

const networkMocks = vi.hoisted(() => ({
  agentClose: vi.fn(),
  agentOptions: [] as unknown[],
  fetch: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  lookup: networkMocks.lookup,
}));

vi.mock("undici", () => ({
  Agent: class MockAgent {
    constructor(options: unknown) {
      networkMocks.agentOptions.push(options);
    }

    close(): Promise<void> {
      return networkMocks.agentClose();
    }
  },
}));

const REQUEST_OPTIONS = {
  headers: { Accept: "text/plain" },
  maxResponseSize: 100,
  signal: new AbortController().signal,
} as const;

interface MockResponse {
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}

beforeEach(() => {
  networkMocks.agentClose.mockReset();
  networkMocks.agentClose.mockResolvedValue(undefined);
  networkMocks.agentOptions.length = 0;
  networkMocks.fetch.mockReset();
  vi.stubGlobal("fetch", networkMocks.fetch);
  networkMocks.lookup.mockReset();
  networkMocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestPublicUrl", () => {
  it("rejects HTTP and non-network URLs", async () => {
    for (const url of ["http://example.com", "file:///etc/passwd"]) {
      await expect(requestPublicUrl(url, REQUEST_OPTIONS), url).rejects.toThrow(
        "URL must start with https://",
      );
    }

    expect(networkMocks.lookup).not.toHaveBeenCalled();
    expect(networkMocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects direct loopback, private, link-local, and address-translation targets", async () => {
    for (const url of [
      "https://127.0.0.1",
      "https://2130706433",
      "https://10.0.0.1",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]",
      "https://[fc00::1]",
      "https://[::ffff:7f00:1]",
      "https://[::ffff:c0a8:1]",
      "https://[64:ff9b::a9fe:a9fe]",
    ]) {
      await expect(requestPublicUrl(url, REQUEST_OPTIONS), url).rejects.toThrow(
        "URL must not target localhost, private, link-local, or reserved IP addresses",
      );
    }

    expect(networkMocks.lookup).not.toHaveBeenCalled();
    expect(networkMocks.fetch).not.toHaveBeenCalled();
  });

  it("rejects localhost names before DNS resolution", async () => {
    for (const url of [
      "https://localhost",
      "https://localhost.",
      "https://service.localhost",
      "https://service.localhost.",
    ]) {
      await expect(requestPublicUrl(url, REQUEST_OPTIONS), url).rejects.toThrow(
        "URL must not target localhost",
      );
    }

    expect(networkMocks.lookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname when any resolved address is private", async () => {
    networkMocks.lookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ]);

    await expect(requestPublicUrl("https://example.com", REQUEST_OPTIONS)).rejects.toThrow(
      "URL must not target localhost, private, link-local, or reserved IP addresses",
    );

    expect(networkMocks.fetch).not.toHaveBeenCalled();
  });

  it("pins the socket lookup to the validated DNS result", async () => {
    networkMocks.lookup.mockResolvedValueOnce([
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]);
    queueResponse({
      body: "public content",
      headers: { "content-type": "text/plain" },
    });

    const response = await requestPublicUrl("https://example.com/page", REQUEST_OPTIONS);

    expect(await response.text()).toBe("public content");
    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
    expect(networkMocks.agentClose).toHaveBeenCalledTimes(1);

    const agentOptions = readAgentOptions(0);
    await expect(readPinnedAddresses(agentOptions.connect.lookup)).resolves.toEqual([
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      { address: "93.184.216.34", family: 4 },
    ]);

    const [, fetchOptions] = networkMocks.fetch.mock.calls[0]!;
    expect(fetchOptions).toMatchObject({
      dispatcher: expect.anything(),
      redirect: "manual",
    });
  });

  it("validates redirect destinations before making the next request", async () => {
    queueResponse({
      headers: { location: "https://169.254.169.254/latest/meta-data" },
      status: 302,
    });

    await expect(requestPublicUrl("https://example.com", REQUEST_OPTIONS)).rejects.toThrow(
      "URL must not target localhost, private, link-local, or reserved IP addresses",
    );

    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
    expect(networkMocks.agentClose).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects that downgrade to HTTP", async () => {
    queueResponse({
      headers: { location: "http://example.com/insecure" },
      status: 302,
    });

    await expect(requestPublicUrl("https://example.com", REQUEST_OPTIONS)).rejects.toThrow(
      "URL must start with https://",
    );

    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
    expect(networkMocks.agentClose).toHaveBeenCalledTimes(1);
    expect(networkMocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("re-resolves and rejects a private hostname after a redirect", async () => {
    networkMocks.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "192.168.1.10", family: 4 }]);
    queueResponse({
      headers: { location: "https://internal.example.com/admin" },
      status: 302,
    });

    await expect(requestPublicUrl("https://example.com", REQUEST_OPTIONS)).rejects.toThrow(
      "URL must not target localhost, private, link-local, or reserved IP addresses",
    );

    expect(networkMocks.fetch).toHaveBeenCalledTimes(1);
    expect(networkMocks.agentClose).toHaveBeenCalledTimes(1);
    expect(networkMocks.lookup).toHaveBeenCalledTimes(2);
  });

  it("follows redirects whose resolved destinations remain public", async () => {
    networkMocks.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "93.184.216.35", family: 4 }]);
    queueResponse({
      headers: { location: "https://cdn.example.com/article" },
      status: 301,
    });
    queueResponse({
      body: "article",
      headers: { "content-type": "text/plain" },
    });

    const response = await requestPublicUrl("https://example.com", REQUEST_OPTIONS);

    expect(await response.text()).toBe("article");
    expect(networkMocks.fetch).toHaveBeenCalledTimes(2);
    expect(networkMocks.agentClose).toHaveBeenCalledTimes(2);
  });

  it("rejects declared and streamed bodies over the response limit", async () => {
    queueResponse({
      headers: { "content-length": "101" },
    });

    await expect(requestPublicUrl("https://example.com/declared", REQUEST_OPTIONS)).rejects.toThrow(
      "Response too large",
    );

    queueResponse({
      body: "x".repeat(101),
    });

    await expect(requestPublicUrl("https://example.com/streamed", REQUEST_OPTIONS)).rejects.toThrow(
      "Response too large",
    );

    expect(networkMocks.agentClose).toHaveBeenCalledTimes(2);
  });
});

function queueResponse(response: MockResponse): void {
  networkMocks.fetch.mockResolvedValueOnce(
    new Response(response.body ?? "", {
      headers: response.headers,
      status: response.status ?? 200,
    }),
  );
}

function readAgentOptions(index: number): { connect: { lookup?: LookupFunction } } {
  return networkMocks.agentOptions[index] as { connect: { lookup?: LookupFunction } };
}

function readPinnedAddresses(pinnedLookup: LookupFunction | undefined): Promise<unknown> {
  return new Promise((resolve, reject) => {
    expect(pinnedLookup).toBeTypeOf("function");

    pinnedLookup!("example.com", { all: true }, (error, addresses) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve(addresses);
    });
  });
}
