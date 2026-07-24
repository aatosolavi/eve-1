# dist-extensions

Proves extension packages work across npm-compatible package managers in both
directions:

- `gadget-extension`: `pnpm publish` → `npm install`
- `gizmo-extension`: `npm publish` → `pnpm install`

The e2e workflows build the packages, then run
`prepare-publish-consumers.sh`. The script starts a loopback-only Verdaccio
registry, publishes each extension with its assigned package manager, and
installs it into an isolated consumer with the other package manager. Each
consumer gets only one extension and runs that extension's eval.

This exercises both npm's physical `node_modules` layout and pnpm's virtual
store layout using the published package entrypoints and agent-shaped
`dist/extension` trees. No extension author source or workspace link is
available to either consuming agent.

The checked-in `file:` dependencies keep the fixture usable during ordinary
workspace development, but CI replaces that installation before running its
evals. The fixture has no `typecheck` script because its generated extension
declarations do not exist in jobs that skip the extension build.
