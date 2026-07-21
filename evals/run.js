#!/usr/bin/env node

// Run eve authoring evals against baseline and documentation-guided variants.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const evalsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(evalsDir, "..");
const fixturesDir = path.join(evalsDir, "evals");
const experimentsDir = path.join(evalsDir, "experiments");
const tarballDir = path.join(evalsDir, ".tarballs");
const tarballPath = path.join(tarballDir, "eve.tgz");
const resultsDir = path.join(evalsDir, "results");

const variants = [
  {
    suffix: "baseline",
    imports: `import { installEve } from '../lib/setup.js'`,
    setup: `await installEve(sandbox)`,
  },
  {
    suffix: "agents-md",
    imports: `import { installEve, writeAgentsMd } from '../lib/setup.js'`,
    setup: `await installEve(sandbox)\n    await writeAgentsMd(sandbox)`,
  },
  {
    suffix: "eve-skill",
    imports: `import { installEve, writeEveSkill } from '../lib/setup.js'`,
    setup: `await installEve(sandbox)\n    await writeEveSkill(sandbox)`,
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

function writeExperiments(evalName) {
  fs.rmSync(experimentsDir, { recursive: true, force: true });
  fs.mkdirSync(experimentsDir, { recursive: true });

  const evalsField = evalName === null ? "" : `\n  evals: ${JSON.stringify(evalName)},`;
  for (const variant of variants) {
    const source = `import type { ExperimentConfig } from '@vercel/agent-eval'
${variant.imports}
import { recordTokenUsage } from '../lib/token-usage.js'

const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  model: 'claude-opus-4-8',${evalsField}
  judge: { model: 'claude-haiku-4-5' },
  scripts: ['build'],
  runs: 1,
  earlyExit: true,
  timeout: 720,
  sandbox: 'auto',
  onRunComplete: recordTokenUsage,
  setup: async (sandbox) => {
    ${variant.setup}
  },
}

export default config
`;
    fs.writeFileSync(path.join(experimentsDir, `${variant.suffix}.ts`), source);
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

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatInteger(value) {
  return Math.round(value).toLocaleString("en-US");
}

function printTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const formatRow = (row) =>
    row
      .map((cell, index) =>
        index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]),
      )
      .join("  ");

  console.log(formatRow(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(formatRow(row));
}

function printResultSummary(resultFiles) {
  if (resultFiles.length === 0) return;

  const resultsByVariant = new Map();
  for (const resultFile of resultFiles) {
    const variant = path.relative(resultsDir, resultFile).split(path.sep)[0];
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    const results = resultsByVariant.get(variant) ?? [];
    results.push(result);
    resultsByVariant.set(variant, results);
  }

  const rows = [];
  for (const variant of variants) {
    const results = resultsByVariant.get(variant.suffix);
    if (results === undefined) continue;

    const passed = results.filter((result) => result.status === "passed").length;
    const accuracy = `${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%)`;
    const duration = `${mean(results.map((result) => result.duration)).toFixed(1)}s`;
    const usages = results
      .map((result) => result.analysis?.tokenUsage)
      .filter((usage) => usage !== undefined);

    if (usages.length === 0) {
      rows.push([
        variant.suffix,
        accuracy,
        `0/${results.length}`,
        "—",
        "—",
        "—",
        "—",
        "—",
        "—",
        duration,
      ]);
      continue;
    }

    const usage = (field) => formatInteger(mean(usages.map((entry) => entry[field])));
    rows.push([
      variant.suffix,
      accuracy,
      `${usages.length}/${results.length}`,
      usage("totalTokens"),
      usage("totalInputTokens"),
      usage("inputTokens"),
      usage("cacheCreationInputTokens"),
      usage("cacheReadInputTokens"),
      usage("outputTokens"),
      duration,
    ]);
  }

  console.log("\nEvaluation summary (token counts are means per reported run):");
  printTable(
    [
      "Variant",
      "Accuracy",
      "Token runs",
      "Total",
      "Input",
      "Uncached",
      "Cache write",
      "Cache read",
      "Output",
      "Duration",
    ],
    rows,
  );
}

function printUsage(options = {}) {
  const write = options.error ? console.error : console.log;
  write("Usage: pnpm --filter evals eval <eval-name> [--dry]");
  write("       pnpm --filter evals eval --all [--dry]");
}

function parseArguments() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
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

  return { all: values.all ?? false, dry: values.dry ?? false, evalName };
}

function main() {
  const argv = parseArguments();
  const evalName = argv.all ? null : argv.evalName;

  if (!fs.existsSync(path.join(root, "packages/eve/dist"))) {
    console.error("packages/eve/dist not found. Run `pnpm --filter eve build` first.");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(root, "packages/eve/docs"))) {
    console.error("packages/eve/docs not found. Run `pnpm --filter eve build` first.");
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

  writeExperiments(evalName);
  fs.mkdirSync(resultsDir, { recursive: true });
  console.log(
    evalName === null
      ? "> Running all evals (baseline + agents-md + eve-skill)"
      : `> Running ${evalName} (baseline + agents-md + eve-skill)`,
  );

  const agentEvalArgs = argv.dry
    ? ["status"]
    : ["run", ...variants.map((variant) => variant.suffix), "--force"];
  const executable = path.join(evalsDir, "node_modules/.bin/agent-eval");
  const existingResults = new Set(listResultFiles());
  const result = spawnSync(executable, agentEvalArgs, {
    cwd: evalsDir,
    stdio: "inherit",
    env: { ...process.env, EVE_EVAL_TARBALL: tarballPath },
  });

  if (result.error) {
    console.error(`Failed to run ${executable}: ${result.error.message}`);
    if (result.error.code === "ENOENT") {
      console.error("Did you run `pnpm install`?");
    }
    process.exit(1);
  }
  printResultSummary(listResultFiles().filter((resultFile) => !existingResults.has(resultFile)));
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
