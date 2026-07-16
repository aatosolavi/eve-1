---
title: "Extensions"
description: "Package tools, connections, skills, and hooks as a reusable package and mount it into an agent."
---

An extension packages eve capabilities — tools, connections, skills, instructions, hooks — as a reusable npm or local package. You author it as an agent-shaped directory; a consuming agent mounts it under `agent/extensions/`, and its contributions compose into the agent under a namespace. Nothing is copied — upgrades come through the package manager.

## Authoring

Start from a scaffold:

```bash
npx eve@latest extension init my-crm
```

This creates the package, installs dependencies, and initializes Git. You get `extension/extension.ts`, TypeScript config, and a `package.json` ready to publish or mount. Add tools, skills, hooks, and connections under `extension/` yourself.

An extension is an agent-shaped directory without `agent.ts` or `sandbox` (those belong to the consuming agent). Every slot works as it does in an agent, with names derived from paths.

```
@acme/crm/
  package.json
  extension/
    extension.ts        # the extension declaration — see Configuration
    tools/search.ts
    connections/api.ts
    skills/triage/SKILL.md
    hooks/audit.ts
    lib/http.ts         # shared helpers, imported as ../lib/http
```

Name tools and connections for what they do (`search`, not `crm_search`) — the mount supplies the namespace. Shared code goes in `extension/lib/`, imported by relative path — eve compiles the source, so relative imports need no `.js` extension.

### Configuration

Declare the extension in `extension/extension.ts` with `defineExtension`; its default export is the mount factory a consumer calls. Pass `config` — any [Standard Schema](https://standardschema.dev) (a Zod object here), like a tool's `inputSchema` — to accept consumer settings:

```ts title="extension/extension.ts"
import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    apiKey: z.string(),
    baseUrl: z.string().default("https://api.acme.example"),
  }),
});
```

Config is optional — `defineExtension()` with no schema. Read it off the handle, imported from the declaration; it's typed from the schema:

```ts title="extension/tools/search.ts"
import { defineTool } from "eve/tools";

import extension from "../extension";

export default defineTool({
  description: "Search the CRM.",
  inputSchema: {/* ... */},
  async execute({ query }) {
    const { apiKey, baseUrl } = extension.config; // validated, defaults applied
  },
});
```

Config is bound once when the consumer mounts the extension and stays constant for the session; per-request values belong in connection auth instead.

### State

`defineState` is scoped to the extension's package automatically, so identically-named state never collides with the consuming agent or another extension. Author it exactly as in an agent — `defineState("budget", …)`.

## Publishing

Point `eve.extension` at the source directory and run `eve extension build` (wired to `build`/`prepare`):

```jsonc title="package.json"
{
  "name": "@acme/crm",
  "type": "module",
  "eve": { "extension": "./extension" },
  "files": ["dist"],
  "peerDependencies": { "eve": ">=0.24.5 <1" },
  "dependencies": { "zod": "^3" },
  "scripts": { "build": "eve extension build", "prepare": "eve extension build" },
}
```

An authored `tsconfig.json` is optional. When present, eve uses it for declaration emit; `moduleResolution: "bundler"` lets relative imports omit `.js` extensions:

```jsonc title="tsconfig.json"
{
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "types": ["node"],
  },
  "include": ["extension/**/*.ts"],
}
```

`eve extension build` compiles the package into `dist/`: the mount factory (`index.mjs`), the `tools/` re-export barrel that overrides use, each contribution as a runnable `.mjs`, skill resources, type declarations, and a `_ext-manifest.json` describing the contributions. It also fills the package `exports` map. Declaration errors fail the build, and a failed build leaves the previous `dist/` in place.

A consuming agent composes an installed extension from this artifact alone: discovery reads the manifest and the runtime imports the compiled modules. Your source is never recompiled or executed by the consumer, so you can ship a closed-source package.

Contributions compile as one code-split graph. Source shared by several contributions (`extension/lib/…`) is emitted once under `dist/_chunks/`, so module-level values like a shared cache behave the same in the published package as in workspace development.

When the `extension/` source directory exists, the consumer compiles that live source instead, even if `dist/` is present — an in-progress workspace extension keeps hot-reloading under `eve dev`. The artifact path applies to installed packages that ship only `dist/`.

### Compatibility

There is no source for the consumer to typecheck, so `dist/_ext-manifest.json` carries two stamps the consuming agent's build validates:

- The eve version the extension was built with. The build typechecks your source against that eve, making it a verified minimum: a consumer on an older eve fails its build instead of crashing mid-session when a tool calls an API its eve doesn't have.
- A contract version for each capability the extension uses (tools, skills, connections, …). If eve changes one of those contracts, the consumer's build fails with a message to rebuild the extension.

These stamps are the compatibility contract for compiled artifacts; the `peerDependencies.eve` range still applies to source-backed mounts and package-manager resolution. Because the build eve becomes your package's minimum, build releases with the oldest eve you intend to support.

### Dependencies

`eve` is a peer dependency: one eve lives in the consuming app and the extension's `eve/*` imports resolve to it. While eve is in beta, new scaffolds accept versions from the installed eve release up to 1.0 (for example `">=0.24.5 <1"`). Everything else (SDKs, `zod`, …) goes in `dependencies`, `optionalDependencies`, or `peerDependencies` as in any npm package.

Only the extension's own source is compiled into `dist/`. Bare package imports stay external and resolve from `node_modules` at the consumer, including workspace-linked packages and subpaths. Importing a package you haven't declared fails the build — a hoisted workspace dependency would otherwise work locally and break once published. A dependency the consuming agent's `eve build` can't bundle (a native addon) must go in the consuming agent's `build.externalDependencies`; extensions can't declare build config, so note it in your README.

Declarations ship in `dist/`, so `files: ["dist"]` is everything you publish.

## Mounting

A consuming agent mounts an extension under `agent/extensions/` — a single file, or a directory when it needs [overrides](#overrides). The namespace is the file basename or directory name; contributions compose as `<namespace>__<name>` (`crm__search`, `crm__api`).

```ts title="agent/extensions/crm.ts"
import crm from "@acme/crm";

export default crm({ apiKey: process.env.CRM_API_KEY });
```

A no-config extension takes no factory call — mount it with a bare re-export:

```ts title="agent/extensions/gizmo.ts"
export { default } from "@acme/gizmo";
```

### Overrides

To override a mounted extension's contributions, author the mount as a directory: the declaration in `extension.ts`, override slots alongside it.

```
agent/extensions/crm/
  extension.ts         # export default crm({ apiKey: process.env.CRM_API_KEY })
  tools/search.ts      # composes as crm__search, shadowing the extension's own
```

A file in an override slot composes under the mount namespace and wins on a name collision. Name it for the bare contribution name (`search`, not `crm__search`) — the directory supplies the prefix. To tweak the extension's own definition, import and re-define it:

```ts title="agent/extensions/crm/tools/search.ts"
import { search } from "@acme/crm/tools";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";

export default defineTool({ ...search, approval: always() });
```

Or drop it entirely by opting out of the slot with `disableTool()`:

```ts title="agent/extensions/crm/tools/search.ts"
import { disableTool } from "eve/tools";

export default disableTool();
```

An override targets one slot, matched by name and kind: a static file replaces the extension's static tool, a dynamic file replaces its dynamic resolver, and `disableTool()` removes whichever the extension put there. Because a dynamic tool wins over a same-named static one at runtime, replace or disable a dynamic tool through its own slot — a static file of the same name won't shadow it.

Overrides only work here — the `<namespace>__` prefix is reserved, so an agent-root contribution named `crm__…` is a build error and an extension can't be shadowed from outside its mount.

### Typed tool results

A consuming agent can narrow a mounted extension's tool result in a hook: import the tool from the extension's `./tools` export and pass it to [`toolResultFrom`](/guides/hooks#narrowing-tool-results). It matches the namespaced result (`crm__search`) because identity keys off the tool definition, not its name.

```ts title="agent/hooks/narrow-crm.ts"
import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { search } from "@acme/crm/tools";

export default defineHook({
  events: {
    "action.result"(event) {
      const match = toolResultFrom(event.data.result, search);
      if (match) console.log(match.output); // typed as search's output
    },
  },
});
```

Matching keys off the tool's description, so keep extension tool descriptions distinct — one shared with another tool makes the identity ambiguous and `toolResultFrom` stops matching.

## Limits

An extension cannot declare a `sandbox`, agent config, schedules, or limits, and cannot mount other extensions — those are the consuming agent's to own (background scheduling, for instance, runs on the agent's deployment under its limits). An extension's tools run within the consuming agent's per-session limits.
