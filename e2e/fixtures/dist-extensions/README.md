# dist-extensions

Proves extensions packaged with pnpm can be installed with npm and run by a
consuming eve agent.

The e2e workflows build `eve`, `gizmo-extension`, and `gadget-extension`, then
run `prepare-npm-consumer.sh`. The script packages all three with `pnpm pack`,
which produces the artifact `pnpm publish` would upload, and installs those
tarballs into an isolated consumer with `npm install`. The fixture evals run
from that consumer rather than the pnpm workspace.

This exercises the published package entrypoints and agent-shaped
`dist/extension` trees with npm's physical `node_modules` layout. No extension
author source or pnpm workspace link is available to the consuming agent.

The checked-in `file:` dependencies keep the fixture usable during ordinary
workspace development, but CI replaces that installation before running its
evals. The fixture has no `typecheck` script because its generated extension
declarations do not exist in jobs that skip the extension build.
