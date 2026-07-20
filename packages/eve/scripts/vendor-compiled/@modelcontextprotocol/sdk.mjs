import { loadDeclaration } from "../_shared.mjs";

export default {
  packageName: "@modelcontextprotocol/sdk",
  compiledPath: "@modelcontextprotocol/sdk",
  chunkGroup: "workflow",
  entries: [
    {
      entry: "dist/esm/server/index.js",
      outputPath: "server",
      declaration: await loadDeclaration("@modelcontextprotocol/server.d.ts"),
    },
    {
      entry: "dist/esm/server/webStandardStreamableHttp.js",
      outputPath: "web-standard-streamable-http",
      declaration: await loadDeclaration("@modelcontextprotocol/web-standard-streamable-http.d.ts"),
    },
    {
      entry: "dist/esm/types.js",
      outputPath: "types",
      declaration: await loadDeclaration("@modelcontextprotocol/types.d.ts"),
    },
  ],
  platform: "neutral",
};
