import { defineConfig } from "vitest/config";

const EVE_ROOT = new URL("../../../packages/eve/", import.meta.url);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "eve/client",
        replacement: new URL("src/client/index.ts", EVE_ROOT).pathname,
      },
      {
        find: /^#compiled\/(.+)\.js$/,
        replacement: new URL(".generated/compiled/$1.js", EVE_ROOT).pathname,
      },
      {
        find: /^#(.+)\.js$/,
        replacement: new URL("src/$1.ts", EVE_ROOT).pathname,
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
