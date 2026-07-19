---
issue: TBD
status: proposed
last_updated: "2026-07-18"
---

# Identifying eve requests to Vercel AI Gateway

## Summary

eve routes model calls through the Vercel AI Gateway (implicitly, via bare
string model ids). We want gateway-side behavior to be customizable for eve
traffic in some circumstances, which first requires reliably identifying a
request as eve-originated.

Today the only identification is per-agent app attribution — `x-title`
(agent name/id) and `http-referer` (Vercel deployment URL) — set in
`buildGatewayAttributionHeaders` (`packages/eve/src/harness/tool-loop.ts`).
That signal is **conditional**: it sends nothing when neither an agent name/id
nor a `VERCEL_*` host is present (typical local dev), and it never marks the
request as "eve the framework" — only which agent/deployment sent it.

This proposal adds two **always-on, framework-level** identifiers to every
gateway-routed request:

- A `User-Agent` token — `eve/<version>` — the semantically correct "this
  client is eve" marker.
- An `x-eve-version` header carrying the eve package version.

Both are additive; existing per-agent attribution is unchanged.

## Scope

- Applies to **gateway-routed models only**, detected by
  `typeof model === "string"` — the same gate the existing attribution uses.
  Direct-provider paths (e.g. the `anthropic-direct` cache path) are out of
  scope here and left as a possible follow-up.
- Both identifiers are **unconditional** for gateway requests, unlike the
  current attribution which is gated on agent name / referer availability.
- Covers both the primary model call and the compaction model call — both
  already receive the attribution header object.

## Externally observable behavior

For any gateway-routed request, the gateway receives:

| Identifier      | Value               | Condition                       |
| --------------- | ------------------- | ------------------------------- |
| `User-Agent`    | `... eve/<version>` | always (gateway-routed request) |
| `x-eve-version` | `<version>`         | always (gateway-routed request) |
| `x-title`       | agent name/id       | existing — when available       |
| `http-referer`  | deployment URL      | existing — when available       |

The version is sourced from the existing `resolveInstalledPackageInfo()`
(`#internal/application/package.js`), the same source the Vercel Sandbox
user-agent already uses.

## Design

### `x-eve-version` — reuse the existing header path

The attribution header object already flows into the AI SDK `headers` option
in two places: `agentSettings.headers` and `maybeCompact({ headers })`. The
version header is added to that object.

`buildGatewayAttributionHeaders` is restructured so the version header is
emitted unconditionally for string models, while `x-title`/`http-referer`
remain conditional. Because the function then always returns at least the
version for a gateway model, it is renamed (e.g. `buildGatewayHeaders`).

### `User-Agent` — mirror the Sandbox pattern

eve already appends an `eve/<version>` token to the user-agent for Vercel
Sandbox traffic via `withEveSandboxUserAgent`
(`execution/sandbox/bindings/vercel-user-agent.ts`). This proposal generalizes
that helper (`eveUserAgentToken()`, `withEveUserAgent()`) and applies it to
gateway traffic. Two implementation options:

**Option 1 — set `User-Agent` via the `headers` option (simplest).** Add
`User-Agent` to the same header object as `x-eve-version`. One-line change, no
provider restructuring. _Risk:_ the AI SDK gateway provider may set its own
`User-Agent` and override or drop a caller-supplied one. Requires an empirical
check of the actual outbound request before committing; if the provider wins,
this option is out.

**Option 2 — explicit gateway provider with a custom `fetch` (robust,
recommended).** Introduce `withEveUserAgent(inner)`, construct a gateway
provider via `createGateway({ fetch: withEveUserAgent(globalThis.fetch) })`,
and route string models through it. Appends `eve/<version>` to whatever UA the
provider already sets, so it is additive rather than a header fight, and it
matches the pattern the codebase already blesses for Sandbox. _Cost:_ eve
currently keeps models as bare strings specifically so the AI SDK routes them
implicitly (`resolve-model.ts`). Converting to an explicit provider instance
touches model resolution and the `typeof model === "string"` gateway-detection
assumptions (cache path, attribution); those must be preserved.

## Files touched

- `packages/eve/src/harness/tool-loop.ts` — restructure/rename
  `buildGatewayAttributionHeaders` (version always-on); Option 2 also wires
  provider construction.
- `packages/eve/src/harness/compaction.ts` — already forwards `headers`;
  verify under Option 2.
- `packages/eve/src/execution/sandbox/bindings/vercel-user-agent.ts` —
  generalize the token/wrapper into a shared helper; Sandbox keeps using it.
- `packages/eve/src/runtime/agent/resolve-model.ts` — Option 2 only.

## Interaction concerns

- **Prompt cache.** Attribution headers already vary per request; adding one
  static per-version header is fine. Confirm no cache-key surprise.
- **Direct-provider / non-gateway models.** Unchanged — no gateway headers
  apply. Whether we also want a UA on direct-provider calls is a follow-up.
- **Local dev.** Both identifiers now send even without `VERCEL_*` env — the
  intended win. Confirm we are comfortable emitting version/UA from local runs.
- **Values.** `x-eve-version` is a version string; UA token is `eve/<version>`.
  No identity leakage beyond what attribution already sends.

## Testing

- Unit (`tool-loop.test.ts`, existing attribution tests): assert
  `x-eve-version` present for string models even when title/referer are absent,
  and absent for non-string models; same for the UA token under the chosen
  option.
- `compaction.test.ts`: assert the compaction call carries the version header.
- Option 2: unit test for `withEveUserAgent` (append-vs-set behavior), reusing
  the Sandbox helper's test shape.

## Rollout

- Pre-1.0: `patch` changeset (new behavior, non-breaking).
- Docs: note the new identifiers wherever gateway attribution is documented, if
  anywhere.

## Open questions

1. **UA mechanism** — validate Option 1 empirically first, or go straight to
   Option 2? (Leaning Option 2: matches Sandbox, avoids header-override
   ambiguity.)
2. **Header naming** — `x-eve-version` as proposed, a broader `x-eve-client`,
   or UA only? What does the gateway side prefer to key off?
3. **Value granularity** — version only, or also runtime info (e.g.
   `eve/<version> node/<ver>`)?
4. **Direct-provider calls** — in scope now, or explicit follow-up?
5. **Gateway-side consumption** — what does the gateway team want to match on,
   so we shape the value to fit their queries/rules?
