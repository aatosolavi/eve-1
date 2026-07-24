---
title: "Tool authorization"
description: "Suspend a tool on an external authorization — OAuth, device code, push-to-approve — and resume durably when the callback arrives."
url: /tools/authorization
---

Some tools cannot run until a person authorizes something outside the session — signing in to an OAuth provider, confirming a device code, approving a push notification. `requestAuthorization` lets a tool's `execute` suspend the turn durably on an external callback, the same lifecycle [connections](/docs/connections) use for interactive OAuth.

This differs from [human-in-the-loop](/docs/human-in-the-loop) approval: an approval answers _inside_ the session (the caller replies), while an authorization completes _outside_ it (an external system hits a callback URL).

## The lifecycle

1. `execute` returns `requestAuthorization([...challenges])`. Each challenge carries a `name`, a user-facing `challenge` (URL, user code, instructions), and the `hookUrl` from `getHookUrl(name)`.
2. eve emits an `authorization.required` stream event per challenge and parks the turn. Channels render the challenge as a sign-in affordance. The model sees only an opaque "authorization pending" output — never the URL or user code.
3. The external system (an IdP redirect, or your own flow) requests the hook URL. Query parameters are captured as the callback payload; headers are not.
4. The turn resumes: eve emits `authorization.completed` with `outcome: "authorized"` and re-executes the tool call, where `getAuthorizationResult(name)` now returns the parsed callback.

```ts title="agent/tools/acquire_credential.ts"
import { defineTool, getAuthorizationResult, getHookUrl, requestAuthorization } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Acquire a credential that a person must authorize out of band.",
  inputSchema: z.object({}),
  async execute() {
    const result = getAuthorizationResult("device");
    if (result === undefined) {
      const hookUrl = getHookUrl("device");
      if (hookUrl === undefined) throw new Error("No session context for authorization.");
      return requestAuthorization([
        {
          name: "device",
          challenge: { url: hookUrl, instructions: "Open the link to authorize." },
          hookUrl,
        },
      ]);
    }
    return exchange(result.callback.params);
  },
});
```

`getAuthorizationResult(name)` returns `undefined` on the first execution and an `AuthorizationResult` on the post-callback re-execution, so the same `execute` body handles both phases. `result.callback.params` holds the callback's query parameters (e.g. an OAuth `code` and `state`).

The pause is durable: nothing is held in memory while the turn waits, and the parked turn survives process restarts. Inside a [subagent](/docs/subagents) — local or [remote](/docs/guides/remote-agents) — the `authorization.required` and `authorization.completed` events propagate to the caller's stream, so the sign-in affordance surfaces wherever the root conversation lives.

## When to use a connection instead

If the credential belongs to an external MCP or OpenAPI server the model calls through a [connection](/docs/connections), author the flow on the connection's `auth` instead — the runtime then owns token caching and re-authorization. Reach for `requestAuthorization` when the authorization gates a tool you author yourself.

## What to read next

- [Human-in-the-loop](/docs/human-in-the-loop): pauses answered inside the session
- [Connections](/docs/connections): interactive OAuth for external servers
- [Remote agents](/docs/guides/remote-agents): how authorization events propagate across deployments
