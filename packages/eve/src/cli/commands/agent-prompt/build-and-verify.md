## Build it out, then verify

Work from the project directory. Once eve is installed, the full docs are bundled
with the installed package and match its version exactly. In most installs, they
are at `node_modules/eve/docs/`. In workspaces or local package installs, resolve
the installed `eve` package location first and read its `docs/` directory. If
package docs are unavailable, use https://eve.dev/docs as a fallback. Read
`README.md` in the package docs first, then the guide for what you're adding,
such as `connections`, `channels/slack`, or `guides/auth-and-route-protection`
for the Vercel Connect flow.

Install eve's coding-agent skill before editing so the harness has the same
versioned workflow guidance:

    npx skills add vercel/eve

- Put the purpose in `agent/instructions.md` (the always-on system prompt),
  replacing the scaffold's placeholder with what the user said the agent should
  do.
- Add a first typed tool under `agent/tools/` with `defineTool` from `eve/tools`
  and a Zod `inputSchema`.

Start eve without the terminal UI, then exercise one representative turn
through the documented session HTTP protocol:

    {{devCommand}} --no-ui

Use the current `eve dev` invocation log to inspect the full local runtime trace.
To find an earlier invocation, list the available logs:

    npx eve logs --no-follow
    npx eve logs <log-id> --no-follow
    npx eve logs ls

When the user is ready to use their agent's REPL, give them the interactive
command to run from the project directory:

    {{devCommand}}

Verify the project's typecheck passes, stop the headless development server,
adapt the model and provider to the user's
data and use case, and don't commit unless the user asks.
