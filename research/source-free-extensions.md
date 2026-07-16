---
issue: TBD
status: implemented
last_updated: "2026-07-16"
---

# Source-free extension distribution

## Summary

Previously an extension shipped its TypeScript **source** (`files: ["extension", "dist"]`) and
the consuming agent **recompiled that source** at its own build, against its own eve. That
recompile is what rebinds `eve/*` to the one consumer eve, bakes state/config scoping, and let
`eve build` typecheck contributions against the app's eve.

An extension can now be distributed as a **compiled artifact** — a pre-scoped `dist` tree, a
**contribution manifest**, emitted type declarations, and **per-capability version stamps** —
so the consuming agent composes it **without recompiling or executing the extension's source**.
`.ts` source is no longer shipped (`files: ["dist"]`). Compatibility is enforced by a build-time
**per-capability version check** instead of by recompiling and typechecking source.

This is **additive**, not a hard replacement: a consuming agent uses the compiled artifact when
the resolved extension ships one, and falls back to the existing discover-and-recompile-from-source
path when it does not (an unbuilt workspace package). This is the standard Node "source in dev,
built artifact when published" convention (see [Decisions](#decisions)).

The motivation is closed-source / prebuilt extensions, smaller packages, and removing the
consumer's obligation to recompile an extension's source. The explicit cost, accepted here, is
that authoring-surface skew is no longer caught by a typecheck at the consumer (there is no
source to check) — it becomes a per-capability version gate. See [Residual risk](#residual-risk).

**The bar: no regression** in namespacing, overrides, state, config, or any contributable
primitive. The [No-regression analysis](#no-regression-analysis) walks every mechanism.

## Why this is feasible (and where the seams are)

Two facts from the implementation make it work:

1. **Namespacing and override resolution are pure name/path operations at compile time.** The
   `<ns>__<base>` composed name is a string concat (`namespaceContributions` in
   `compiler/normalize-extension.ts`): `<ns>` is the consumer's mount filename/dirname
   (`discover/extensions.ts`), `<base>` is the extension's path-derived contribution name
   (`normalize-tool.ts`), and override precedence is a first-wins dedup by that name
   (`mergeContributions`). None of this reads implementation source — it operates on **names**.

2. **State/config scope is package-derived and baked at the extension's own build.**
   `packageStateNamespace(packageName)` (`discover/extensions.ts`) is a pure function of the
   package name, and `buildExtensionPackage` runs the fixed-namespace scope plugin over every
   emitted module with that namespace. Config binds through a **string-keyed global registry**
   (`Symbol.for("eve.extension-config-registry")`, `public/definitions/extension.ts`), so binding
   and reading agree whenever the namespace _string_ matches — independent of module identity.

The single seam: **kind** (static/dynamic tool, skill, instructions) and **model-facing metadata**
(tool `description`/`inputSchema`/`outputSchema`, dynamic `eventNames`, skill
markdown/frontmatter/assets, instruction text) were obtained by _loading and executing the module
at compile_ (`loadModuleBackedDefinition`). Source-free, they are **stamped in the manifest** at
the extension's build; the runtime still `import()`s the `dist` module for the validator +
`execute`.

## What "source-free" means precisely

- No `.ts` **implementation** source ships. `eve extension build` emits type declarations
  (`tsc --emitDeclarationOnly`) into `dist/_types/`, so the package carries its own types with
  `files: ["dist"]`.
- Markdown/asset **data** (a skill's `SKILL.md` and its resources, instruction fragment text)
  ships as runtime payload — the model consumes it directly.
- `eve/*` is **externalized** in the shipped `dist` (peer, resolves to the consumer's one eve),
  and so are the extension's package `dependencies` (bare imports the consumer resolves from
  `node_modules`, like any normal package — deduped, native addons intact). Only the extension's
  own relative source is inlined, and the emit carries no source map.
- The shipped `dist` is **pre-scoped**: every extension-owned module has its
  `defineState`/`defineExtension` namespace baked at the extension's build.

## The artifact

```
@acme/crm/                         # published; NO ext/*.ts source, files: ["dist"]
  package.json                     # eve.extension, exports → dist, peer eve
  dist/
    _ext-manifest.json             # contribution manifest + capability version stamps
    index.mjs / index.d.ts         # mount factory handle (pre-scoped); .d.ts → _types
    tools/index.mjs / index.d.ts   # tool re-export barrel for consumer overrides
    tools/search.mjs               # pre-scoped; eve/* + package deps external, own source inlined
    skills/triage/SKILL.md         # markdown data + assets
    _types/**/*.d.ts               # emitted declarations the barrels re-export from
    ...
```

### 1. Pre-scoped compiled contribution tree

`buildExtensionPackage` emits **every** contribution module (not just the `.`/`./tools`
entrypoints) as a namespace-scoped `.mjs`, using the distribution bundling path
(`bundleAuthoredModuleForDistribution`) with
`createFixedNamespaceScopePlugin(packageStateNamespace(name))`. Package `dependencies` stay
external; only the extension's own relative source is inlined, and the emit carries no source map
so the `.ts` is not embedded. **Invariant:** the shim must cover the _entire_ extension-owned
graph — a single un-shimmed `defineState` keys its slot without the prefix and silently diverges.

### 2. Contribution manifest (`dist/_ext-manifest.json`)

An independent, versioned contract (`compiler/extension-artifact.ts`, `EXTENSION_ARTIFACT_VERSION`)
carrying the extension's **base-named compiled contributions** — the same
`CompiledExtensionContributions` shape the consumer would otherwise derive by recompiling, minus
the mount prefix/rebase — so the consumer composes without walking source. Per contributable kind
(**tools, dynamicTools, hooks, skills, dynamicSkills, dynamicInstructions, connections,
instructionFragments** — the fixed set in `compiler/normalize-extension.ts`), each entry carries:

- **base name** exactly as the compiler derives it (flattened, `tools/` stripped, `/`→`-`) — so
  `<ns>__<base>` composition is byte-identical;
- **module path** into `dist` (dist-relative; the consumer rebases it for runtime `import()`);
- **model-facing metadata, stamped as JSON**: tool `description` + `inputSchema`/`outputSchema`
  as JSON Schema, dynamic `eventNames`;
- for markdown/skill-package kinds: the **markdown text** and dist-relative **asset paths**
  (connection `connectionName`, skill `name`/`skillId` carried verbatim);
- enumeration in the **same order** discovery produces (depth-first, alphabetical per level).

The manifest also records `packageName`, `packageNamespace`, `eveVersion`, and
`capabilityVersions` (§3).

**Metadata: stamp, not load.** The consumer's build reads model-facing metadata from the manifest
as JSON and **never executes extension code** to compose the compiled agent manifest.
`eve extension build` extracts it at the _extension's_ build (loading its own modules) and
serializes it — eve already converts Standard Schema → JSON Schema for the model. The **runtime**
still `import()`s the `dist` module for the validator + `execute`. This keeps the consumer build
hermetic — important because extensions may be third-party/closed-source.

### 3. Per-capability version stamps

Compatibility is stamped at **per-capability** granularity. eve owns a small integer contract
version for each capability kind (`EXTENSION_CAPABILITY_VERSIONS` in
`compiler/extension-capabilities.ts`): `tool, dynamicTool, connection, hook, skill, dynamicSkill,
instructions, dynamicInstructions, config, state`. `eve extension build` stamps the version of
each capability the extension actually uses (plus `config`/`state`, always, since every extension
binds config through the mount factory and bakes state scope). At the consumer, discovery runs
`validateExtensionCapabilities` and fails with `DISCOVER_EXTENSION_CAPABILITY_INCOMPATIBLE` on any
mismatch, naming the kind and the built/current versions.

A capability version is **hand-maintained**: bump it when a change to that capability would break
an already-built extension (a compiled-definition shape change, a runtime binding change, or the
state/config scoping baked into shipped modules). This is a deliberate human step enforced by
review — no type introspection, no CI snapshot guard.

## Consume-time flow

```
mount extensions/crm.ts ──▶ resolve @acme/crm ──▶ dist/_ext-manifest.json present?
      │ (namespace = "crm", consumer-chosen)          │
      │                                        yes ────┼──── no
      │                                                ▼          ▼
      │                       [A] capability-version check   discover + recompile
      │                        (fail fast ─▶ build error)    from source (retained)
      ▼                                                │
compose <crm>__<base> from manifest names ◀───── read stamped metadata (JSON, no code exec)
      │                                                rebase module paths into node_modules/@acme/crm/dist
      ▼
consumer overrides (extensions/crm/**) always walked from SOURCE, win by name, disableTool applies
      (runtime — not build — import()s the pre-scoped dist modules for validator + execute)
```

- **Discovery** (`locateExtensionMount`) prefers `dist/_ext-manifest.json` when the package ships
  one, attaching it to `ResolvedExtensionMount.artifact` without recursing into source. When it is
  absent, discovery walks the source tree as before (`ResolvedExtensionMount.manifest`).
- **[A] The capability check runs at discovery**, before any `dist` module is imported — a
  mismatch produces a clear "rebuild `@acme/crm`" build error instead of an opaque module-load
  crash.
- **Namespacing** composes `crm__<base>` from the consumer's mount namespace + manifest base
  names — identical to the source path.
- **Overrides** remain a **consumer-source** walk of `extensions/crm/**` (those files are the
  consumer's, always present); they win by name, and `disableTool` targets resolve against the
  manifest's extension tool/dynamic-tool names.
- **State/config** use the pre-baked package namespace; the mount factory binds config through the
  string-keyed registry.
- **Scope passes skip source-free mounts.** The pre-scoped `.mjs` already bake the namespace, so
  `CompiledExtensionMount.sourceFree` excludes them from the three scope passes (prod whole-app
  bundle in `create-application-nitro.ts`, generation module-map bundle, and the dev/eval
  `authored-module-map-loader` scope index) to avoid double-scoping. Only source-backed mounts are
  scoped at the consumer.

## The compatibility check (replaces the source typecheck)

At the consumer's discovery, for each capability the extension stamped, compare its recorded
version against the consumer eve's current version for that capability; **fail on any mismatch**,
naming the extension, the capability, and both versions. The existing `peerDependencies.eve`
semver check (`DISCOVER_EXTENSION_EVE_INCOMPATIBLE`) stays a coarse, friendly gate for
**source-backed** mounts only; for source-free mounts the capability-version check is
authoritative, so the extension's eve dependency can be loose (e.g. `latest`).

## No-regression analysis

Every current behavior, and how the source-free path preserves it.

| Behavior                                                                 | Source of truth (source path)                                       | Preserved by (source-free path)                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `<ns>__<name>` naming                                                    | compile-time concat from consumer mount ns + path-derived base      | manifest carries base names verbatim; consumer mount still drives `<ns>` — the artifact does NOT bake ns |
| Base name derivation (flatten `/`→`-`, strip slot dir)                   | `normalize-tool.ts`, `normalize-skill.ts`                           | base names pre-computed into the manifest in the exact flattened form                                    |
| Consumer overrides win                                                   | overrides-first dedup by name (`mergeContributions`)                | overrides still walked from consumer source; dedup unchanged                                             |
| `disableTool()` removes extension tool, throws if no match               | `applyOverrideDisables`                                             | manifest supplies the extension tool/slug name set to target                                             |
| `DISCOVER_EXTENSION_OVERRIDE_OUTSIDE_MOUNT`                              | name-prefix check at agent root                                     | pure name check over manifest names — unchanged                                                          |
| State key `<pkgns>.<name>`                                               | package-derived, baked by scope plugin at consumer recompile        | pre-baked at extension build; package ns is a pure fn of the package name                                |
| Config binding                                                           | string-keyed global registry, namespace baked into handle           | pre-baked handle + package ns; registry is string-keyed, survives no shared instance                     |
| Two mounts of one package                                                | names disjoint (`crm__`/`sales__`), state/config shared per package | identical — names from mount ns, state from package ns                                                   |
| Same eve instance                                                        | `eve/*` externalized at consumer recompile                          | `eve/*` externalized in shipped dist (peer)                                                              |
| Kind (static/dynamic)                                                    | module load at compile (`loadModuleBackedDefinition`)               | stamped in the manifest as base-named compiled definitions                                               |
| Tool/skill/instruction metadata                                          | module/markdown read at compile                                     | stamped as JSON in the manifest; markdown/assets shipped as data                                         |
| Connection name, skill id, resource paths                                | stamped on refs at discovery                                        | carried verbatim in the manifest                                                                         |
| Enumeration set + order                                                  | recursive source walk, alphabetical per level                       | manifest emits same set + order; `resolvedExtensions` sorted by namespace                                |
| agent-config / sandbox / schedule rejected; channels / subagents dropped | extension-role discovery                                            | rejected/dropped at the extension's own build, before the manifest is written                            |
| Whole-graph scope coverage                                               | path-containment over `sourceRoot` (prod) / fixed-ns (dev)          | fixed-ns scope pass at the extension build covers the entire package graph; consumer skips re-scoping    |

The three things sourced from a consumer recompile — kind, metadata, runnable code — move into the
artifact (manifest + loadable `dist`), and scope moves to the extension's build. The source path is
retained unchanged for unbuilt/workspace extensions.

## Residual risk (what is genuinely lost)

1. **No consumer-side typecheck of contributions.** Surface skew (e.g. a removed
   `ctx.getSandbox()`) is a **runtime error**, not a build failure — caught by the capability check
   only if the relevant capability version was bumped. Running the check at discovery, before any
   dist module is imported, turns an opaque import crash into a clear build failure.
2. **The scope shims are compiled against publish-time `eve/context`/`eve/extension`.** If eve
   changes the runtime contract of `defineState`/`defineExtension`, the `state`/`config` capability
   versions must move so the comparison catches it.
3. **Behavioral breaks** (unchanged type/signature, changed semantics) are uncatchable by any
   version scheme — same as before, and same as Elm/cargo-semver-checks.
4. **Capability versions are hand-maintained.** A break is caught only if the human bumped the
   affected capability version. The coarse per-capability granularity trades precision (a bump
   flags every extension using that capability, not only those that touch the changed member) for
   a gate that needs no type introspection and no CI tooling.

## Decisions

1. **Artifact when built, source when not** (the Node "internal packages" convention). The
   consumer uses the compiled artifact when the resolved extension ships `dist/_ext-manifest.json`
   and falls back to the retained source discover-and-recompile path otherwise. This preserves
   zero-build live reload for unbuilt workspace extensions, so a dedicated
   `eve extension build --watch` is **not** required.
2. **Per-capability version stamps**, hand-maintained (see [§3](#3-per-capability-version-stamps)).
   Chosen over per-symbol fingerprints: no type introspection or CI snapshot guard, at the cost of
   coarser precision.
3. **Stamp metadata, don't load it** — the consumer build reads model-facing metadata as JSON and
   never executes extension code; the runtime still loads the `dist` module for the validator +
   `execute`.
4. **Package dependencies stay external**, like a normal published package (deduped by the
   package manager, native addons intact); only the extension's own source is inlined.
5. **No source ships.** Type declarations are emitted into `dist/_types/` at the extension's
   build, so `files: ["dist"]` carries everything (runtime + types + manifest).

## Implementation

- **New:** `compiler/extension-capabilities.ts` (version registry + `validateExtensionCapabilities`),
  `compiler/extension-artifact.ts` (`ExtensionArtifact` schema + I/O).
- **Build:** `internal/nitro/host/build-extension.ts` emits the pre-scoped `.mjs` tree, copies
  skill assets, stamps `dist/_ext-manifest.json`, and emits declarations into `dist/_types/`.
- **Discovery:** `discover/extensions.ts` / `discover/discover-agent.ts` resolve the artifact and
  validate capabilities; `ResolvedExtensionMount` carries `manifest?` (source) or `artifact?`.
- **Compile:** `compiler/normalize-extension.ts` composes from the artifact without loading code
  (`compileExtensionContributions` branches on `mount.artifact`); `CompiledExtensionMount.sourceFree`
  drives scope-pass exclusion.
- **Fixtures:** `e2e/fixtures/toolkit-extension` is source-free (built in CI, `dist/` gitignored);
  `gizmo-extension` stays source-backed, so the `extensions` consumer exercises both paths.
- **Scaffold:** `eve extension init` (`setup/scaffold/create/extension.ts`) generates
  `files: ["dist"]`, dist-shaped `exports`, and a build/prepare wired to `eve extension build`.

## Follow-ups

- **`eve extension build --watch`** as a convenience for the built-extension workspace loop (not
  required — the source fallback covers workspace dev today).
- If finer compatibility precision is ever needed, per-symbol fingerprints could replace the
  per-capability stamps behind the same manifest field.
