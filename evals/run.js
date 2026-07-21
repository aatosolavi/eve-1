#!/usr/bin/env node

// Run eve authoring evals against baseline and documentation-guided variants.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { currentSnapshot, prepareReferencePackage, resolveReference } from "./lib/comparison.js";
import { printResultSummary } from "./lib/report.js";

const evalsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(evalsDir, "..");
const fixturesDir = path.join(evalsDir, "evals");
const experimentsDir = path.join(evalsDir, "experiments");
const tarballDir = path.join(evalsDir, ".tarballs");
const tarballPath = path.join(tarballDir, "eve.tgz");
const referenceTarballPath = path.join(tarballDir, "eve-reference.tgz");
const resultsDir = path.join(evalsDir, "results");

const variants = [
  {
    suffix: "baseline",
    imports: `import { installEve } from '../lib/setup.js'`,
    setup: (snapshot) => `await installEve(sandbox, '${snapshot}')`,
  },
  {
    suffix: "agents-md",
    imports: `import { installEve, writeAgentsMd } from '../lib/setup.js'`,
    setup: (snapshot) =>
      `await installEve(sandbox, '${snapshot}')\n    await writeAgentsMd(sandbox)`,
  },
  {
    suffix: "eve-skill",
    imports: `import { installEve, writeEveSkill } from '../lib/setup.js'`,
    setup: (snapshot) =>
      `await installEve(sandbox, '${snapshot}')\n    await writeEveSkill(sandbox, '${snapshot}')`,
  },
];

function pack() {
  fs.mkdirSync(tarballDir, { recursive: true });
  const output = execFileSync("pnpm", ["pack", "--pack-destination", tarballDir], {
    cwd: path.join(root, "packages/eve"),
    encoding: "utf8",
  });
  const produced = output.trim().split("\n").pop();
  if (produced === undefined) {
    throw new Error("pnpm pack did not report an eve tarball path.");
  }

  const producedPath = path.isAbsolute(produced) ? produced : path.join(tarballDir, produced);
  fs.renameSync(producedPath, tarballPath);
}

function createExperiments(comparison) {
  const snapshots = comparison
    ? [comparison.reference, comparison.current]
    : [currentSnapshot(root)];

  return snapshots.flatMap((snapshot) =>
    variants.map((variant) => ({
      ...variant,
      snapshot: snapshot.snapshot,
      suffix: comparison ? `${snapshot.snapshot}-${variant.suffix}` : variant.suffix,
      treatment: variant.suffix,
      metadata: { ...snapshot, treatment: variant.suffix },
    })),
  );
}

function writeExperiments(evalName, experiments) {
  fs.rmSync(experimentsDir, { recursive: true, force: true });
  fs.mkdirSync(experimentsDir, { recursive: true });

  const evalsField = evalName === null ? "" : `\n  evals: ${JSON.stringify(evalName)},`;
  for (const experiment of experiments) {
    const source = `import type { ExperimentConfig } from '@vercel/agent-eval'
${experiment.imports}
import { createResultHook } from '../lib/token-usage.js'

const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: 'claude-opus-4-8',${evalsField}
  judge: { model: 'claude-haiku-4-5' },
  scripts: ['build'],
  runs: 1,
  earlyExit: true,
  timeout: 720,
  sandbox: 'auto',
  onRunComplete: createResultHook(${JSON.stringify(experiment.metadata)}),
  setup: async (sandbox) => {
    ${experiment.setup(experiment.snapshot)}
  },
}

export default config
`;
    fs.writeFileSync(path.join(experimentsDir, `${experiment.suffix}.ts`), source);
  }
}

function listEvals() {
  return fs
    .readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function listResultFiles() {
  if (!fs.existsSync(resultsDir)) return [];
  return fs
    .globSync("**/result.json", { cwd: resultsDir })
    .map((resultPath) => path.join(resultsDir, resultPath));
}

function printUsage(options = {}) {
  const write = options.error ? console.error : console.log;
  write("Usage: pnpm --filter evals eval <eval-name> [--compare <git-ref>] [--dry]");
  write("       pnpm --filter evals eval --all [--compare <git-ref>] [--dry]");
}

function parseArguments() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      compare: { type: "string" },
      dry: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }
  if (positionals.length > 1) {
    throw new Error("Expected at most one <eval-name>.");
  }

  const evalName = positionals[0];
  if (values.all && evalName !== undefined) {
    throw new Error("--all cannot be combined with <eval-name>.");
  }
  if (!values.all && evalName === undefined) {
    throw new Error(
      `Missing <eval-name>.\n\nAvailable evals:\n${listEvals()
        .map((name) => `  ${name}`)
        .join("\n")}`,
    );
  }
  if (evalName !== undefined && !fs.existsSync(path.join(fixturesDir, evalName))) {
    throw new Error(`Unknown eval: ${evalName}`);
  }

  return {
    all: values.all ?? false,
    compare: values.compare,
    dry: values.dry ?? false,
    evalName,
  };
}

function main() {
  const argv = parseArguments();
  const evalName = argv.all ? null : argv.evalName;

  if (!fs.existsSync(path.join(root, "packages/eve/dist"))) {
    console.error("packages/eve/dist not found. Run `pnpm --filter eve build` first.");
    process.exit(1);
  }
  if (process.env.EVE_SKIP_PACK === "1" && fs.existsSync(tarballPath)) {
    console.log("> Reusing existing tarball (EVE_SKIP_PACK=1)");
  } else {
    console.log("> Packing eve...");
    pack();
    const megabytes = (fs.statSync(tarballPath).size / 1024 / 1024).toFixed(1);
    console.log(`  ${tarballPath} (${megabytes} MB)`);
  }

  // loadEnvFile preserves existing values, so load the more specific file first.
  for (const envFile of [".env.local", ".env"]) {
    const source = path.join(root, envFile);
    if (fs.existsSync(source)) {
      process.loadEnvFile(source);
    }
  }

  const comparison =
    argv.compare === undefined
      ? undefined
      : {
          current: currentSnapshot(root),
          reference: resolveReference(root, argv.compare),
        };
  const experiments = createExperiments(comparison);

  if (comparison !== undefined) {
    const referenceSha = comparison.reference.gitSha.slice(0, 12);
    const currentSha = comparison.current.gitSha.slice(0, 12);
    const dirty = comparison.current.dirty ? " + uncommitted changes" : "";
    console.log(
      `> Comparing docs from ${comparison.reference.gitRef} (${referenceSha}) to HEAD (${currentSha}${dirty})`,
    );
  }

  writeExperiments(evalName, experiments);
  fs.mkdirSync(resultsDir, { recursive: true });
  const treatments = variants.map((variant) => variant.suffix).join(" + ");
  console.log(
    evalName === null
      ? `> Running all evals (${treatments})`
      : `> Running ${evalName} (${treatments})`,
  );

  const agentEvalArgs = argv.dry
    ? ["status"]
    : ["run", ...experiments.map((experiment) => experiment.suffix), "--force"];
  const comparisonAssets =
    comparison === undefined
      ? undefined
      : prepareReferencePackage({
          root,
          tarballPath,
          outputPath: referenceTarballPath,
          reference: comparison.reference,
        });
  const executable = path.join(evalsDir, "node_modules/.bin/agent-eval");
  const existingResults = new Set(listResultFiles());
  const env = { ...process.env, EVE_EVAL_TARBALL: tarballPath };
  if (comparisonAssets !== undefined) {
    env.EVE_EVAL_REFERENCE_SKILL = comparisonAssets.skillPath;
    env.EVE_EVAL_REFERENCE_TARBALL = referenceTarballPath;
  }
  let result;
  try {
    result = spawnSync(executable, agentEvalArgs, {
      cwd: evalsDir,
      stdio: "inherit",
      env,
    });
  } finally {
    comparisonAssets?.cleanup();
  }

  if (result.error) {
    console.error(`Failed to run ${executable}: ${result.error.message}`);
    if (result.error.code === "ENOENT") {
      console.error("Did you run `pnpm install`?");
    }
    process.exit(1);
  }
  printResultSummary({
    resultFiles: listResultFiles().filter((resultFile) => !existingResults.has(resultFile)),
    resultsDir,
    experiments,
    comparison: comparison !== undefined,
  });
  process.exit(result.status ?? 1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error();
  printUsage({ error: true });
  process.exit(1);
}
