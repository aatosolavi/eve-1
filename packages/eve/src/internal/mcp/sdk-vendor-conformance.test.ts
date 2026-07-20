import type { Server as UpstreamServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { WebStandardStreamableHTTPServerTransport as UpstreamTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type {
  CallToolRequest as UpstreamCallToolRequest,
  ListToolsRequest as UpstreamListToolsRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server as VendoredServer } from "#compiled/@modelcontextprotocol/sdk/server.js";
import type { WebStandardStreamableHTTPServerTransport as VendoredTransport } from "#compiled/@modelcontextprotocol/sdk/web-standard-streamable-http.js";
import type {
  CallToolRequest as VendoredCallToolRequest,
  ListToolsRequest as VendoredListToolsRequest,
} from "#compiled/@modelcontextprotocol/sdk/types.js";

import { describe, expect, it } from "vitest";

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;

type ConformanceAssertions = readonly [
  IsAssignable<
    ConstructorParameters<typeof VendoredServer>,
    ConstructorParameters<typeof UpstreamServer>
  >,
  IsAssignable<UpstreamTransport, Parameters<VendoredServer["connect"]>[0]>,
  IsAssignable<UpstreamServer["close"], VendoredServer["close"]>,
  IsAssignable<
    ConstructorParameters<typeof VendoredTransport>,
    ConstructorParameters<typeof UpstreamTransport>
  >,
  IsAssignable<UpstreamTransport["handleRequest"], VendoredTransport["handleRequest"]>,
  IsAssignable<UpstreamCallToolRequest, VendoredCallToolRequest>,
  IsAssignable<UpstreamListToolsRequest, VendoredListToolsRequest>,
];

describe("vendored MCP SDK declarations", () => {
  it("remain assignable from the installed SDK surface", () => {
    const assertions: ConformanceAssertions = [true, true, true, true, true, true, true];
    expect(assertions).not.toContain(false);
  });
});
