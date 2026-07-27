import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

import { Agent } from "undici";

import { isLoopbackHostname, isPrivateOrReservedIpAddress } from "#shared/network-address.js";

const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const UNSAFE_DESTINATION_ERROR =
  "URL must not target localhost, private, link-local, or reserved IP addresses.";

/** Options for an SSRF-safe HTTPS request. */
export interface PublicUrlRequestOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly maxResponseSize: number;
  readonly signal: AbortSignal;
}

/**
 * Requests an untrusted HTTPS URL while preventing access to non-public
 * network destinations.
 *
 * Every hostname is resolved before the request, every resolved address must
 * be public, and the request's socket is pinned to that exact result. Redirects
 * repeat the same validation.
 */
export async function requestPublicUrl(
  urlText: string,
  options: PublicUrlRequestOptions,
): Promise<Response> {
  let url = parseHttpsUrl(urlText);

  for (let redirectCount = 0; ; redirectCount += 1) {
    const { dispatcher, response } = await requestOnce(url, options);
    const location = response.headers.get("location");

    if (location === null || !REDIRECT_STATUSES.has(response.status)) {
      try {
        return await consumeResponse(response, options.maxResponseSize);
      } finally {
        await dispatcher.close();
      }
    }

    await cancelResponseBody(response);
    await dispatcher.close();

    if (redirectCount === MAX_REDIRECTS) {
      throw new Error(`Request exceeded the ${MAX_REDIRECTS}-redirect limit.`);
    }

    url = parseHttpsUrl(new URL(location, url).toString());
  }
}

function parseHttpsUrl(urlText: string): URL {
  let url: URL;

  try {
    url = new URL(urlText);
  } catch {
    throw new Error("URL must be a valid absolute https:// URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("URL must start with https://");
  }

  return url;
}

async function requestOnce(
  url: URL,
  options: PublicUrlRequestOptions,
): Promise<{ readonly dispatcher: Agent; readonly response: Response }> {
  const addresses = await resolvePublicAddresses(url.hostname);
  const dispatcher = new Agent({
    connect: {
      lookup: createPinnedLookup(addresses),
    },
  });

  try {
    const fetchOptions: RequestInit & { dispatcher: Agent } = {
      dispatcher,
      headers: options.headers,
      redirect: "manual",
      signal: options.signal,
    };
    const response = await fetch(url, fetchOptions);
    return { dispatcher, response };
  } catch (error) {
    await dispatcher.close();
    throw error;
  }
}

async function resolvePublicAddresses(hostname: string): Promise<readonly LookupAddress[]> {
  const normalizedHostname = hostname.replace(/^\[(.*)\]$/u, "$1");
  const family = isIP(normalizedHostname);

  if (family !== 0) {
    assertPublicAddress(normalizedHostname);
    return [{ address: normalizedHostname, family }];
  }

  if (isLoopbackHostname(normalizedHostname)) {
    throw new Error(UNSAFE_DESTINATION_ERROR);
  }

  const addresses = await lookup(normalizedHostname, { all: true, verbatim: true });

  if (addresses.length === 0) {
    throw new Error(`Unable to resolve URL hostname "${hostname}".`);
  }

  for (const { address } of addresses) {
    assertPublicAddress(address);
  }

  return addresses;
}

function assertPublicAddress(address: string): void {
  if (isPrivateOrReservedIpAddress(address)) {
    throw new Error(UNSAFE_DESTINATION_ERROR);
  }
}

function createPinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, lookupOptions, callback) => {
    const matchingAddresses =
      lookupOptions.family === undefined || lookupOptions.family === 0
        ? addresses
        : addresses.filter(({ family }) => family === lookupOptions.family);

    if (matchingAddresses.length === 0) {
      const error = new Error("Resolved URL hostname has no address in the requested IP family.");
      Object.assign(error, { code: "ENOTFOUND" });
      callback(error, "", 0);
      return;
    }

    if (lookupOptions.all === true) {
      callback(null, [...matchingAddresses]);
      return;
    }

    const selected = matchingAddresses[0]!;
    callback(null, selected.address, selected.family);
  };
}

async function consumeResponse(response: Response, maxResponseSize: number): Promise<Response> {
  const declaredLength = parseContentLength(response.headers.get("content-length"));

  if (declaredLength !== undefined && declaredLength > maxResponseSize) {
    await cancelResponseBody(response);
    throw createResponseTooLargeError();
  }

  const body = await readBoundedBody(response, maxResponseSize);
  const responseBody = body.byteLength === 0 ? null : Uint8Array.from(body).buffer;

  return new Response(responseBody, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBoundedBody(response: Response, maxResponseSize: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      byteLength += value.byteLength;
      if (byteLength > maxResponseSize) {
        await reader.cancel();
        throw createResponseTooLargeError();
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection will still be closed with its per-request dispatcher.
  }
}

function createResponseTooLargeError(): Error {
  return new Error("Response too large (exceeds 5 MB limit).");
}
