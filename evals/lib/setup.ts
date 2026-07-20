import { readFileSync } from "node:fs";

import type { Sandbox } from "@vercel/agent-eval";

/** Installs the locally built eve package in an authoring-eval sandbox. */
export async function installEve(sandbox: Sandbox): Promise<void> {
  const tarballPath = process.env.EVE_EVAL_TARBALL;
  if (tarballPath === undefined) {
    throw new Error("EVE_EVAL_TARBALL is not set. Run evals with `pnpm eval`.");
  }

  await sandbox.writeFiles({
    // @ts-expect-error The runtime accepts Buffer even though the upstream type only names string.
    "eve.tgz": readFileSync(tarballPath),
  });
  const result = await sandbox.runCommand("npm", ["install", "./eve.tgz"]);
  if (result.exitCode !== 0) {
    throw new Error(`npm install ./eve.tgz failed (exit ${result.exitCode}):\n${result.stderr}`);
  }
}

/** Directs coding agents to the version-matched documentation bundled with eve. */
export async function writeAgentsMd(sandbox: Sandbox): Promise<void> {
  const body = `<!-- BEGIN:eve-agent-rules -->

# eve: always read the installed docs before coding

Before writing or changing eve code, find and read the relevant guide in
\`node_modules/eve/docs/\`. Your training data may be outdated; the installed
docs are the source of truth for this version of eve.

<!-- END:eve-agent-rules -->
`;

  await sandbox.writeFiles({
    "AGENTS.md": body,
    "CLAUDE.md": "@AGENTS.md\n",
  });
}
