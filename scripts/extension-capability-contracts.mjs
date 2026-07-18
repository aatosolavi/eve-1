#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPATIBILITY_FIXTURE_ROOT,
  COMPATIBILITY_SOURCE,
  REPORT_ROOT,
  REPO_ROOT,
  parseCapabilityConfiguration,
  toPosix,
  validateCapabilityConfiguration,
} from "./extension-contracts/configuration.mjs";
import { checkCapabilityReports, reportInventoryIssues } from "./extension-contracts/reports.mjs";

function gitOutput(args) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function immutableContractHistoryIssues() {
  const protectedPaths = [
    toPosix(relative(REPO_ROOT, REPORT_ROOT)),
    toPosix(relative(REPO_ROOT, COMPATIBILITY_FIXTURE_ROOT)),
  ];
  const comparisons = [
    ["diff", "--name-status", "--", ...protectedPaths],
    ["diff", "--cached", "--name-status", "--", ...protectedPaths],
  ];
  const hasBase = gitOutput(["rev-parse", "--verify", "origin/main"]) !== undefined;
  if (hasBase) {
    comparisons.push(["diff", "--name-status", "origin/main...HEAD", "--", ...protectedPaths]);
  }

  const changes = new Set();
  for (const args of comparisons) {
    for (const line of (gitOutput(args) ?? "").trim().split("\n")) {
      if (line !== "") changes.add(line);
    }
  }

  const issues = [];
  for (const change of changes) {
    const [status, ...paths] = change.split("\t");
    if (status === "A") continue;
    if (
      hasBase &&
      paths.every((path) => gitOutput(["cat-file", "-e", `origin/main:${path}`]) === undefined)
    ) {
      continue;
    }
    if (paths.every((path) => path.endsWith("README.md"))) continue;
    issues.push({
      file: paths.at(-1) ?? protectedPaths[0],
      message: `Published capability reports and retained compatibility fixtures are immutable (git status ${status}). Bump the capability epoch and add new files instead of changing or deleting existing contract history.`,
    });
  }
  return issues;
}

export async function checkExtensionCapabilityContracts({ update = false } = {}) {
  const source = await readFile(COMPATIBILITY_SOURCE, "utf8");
  const configuration = parseCapabilityConfiguration(source);
  const issues = await validateCapabilityConfiguration(configuration);
  if (!update) issues.push(...immutableContractHistoryIssues());
  if (issues.length === 0) {
    issues.push(...(await checkCapabilityReports(configuration, update)));
    issues.push(...(await reportInventoryIssues(configuration)));
  }
  return issues;
}

async function main() {
  const update = process.argv.includes("--update");
  const issues = await checkExtensionCapabilityContracts({ update });
  if (issues.length > 0) {
    process.stderr.write(
      `[eve:extension-contracts] FAIL: ${issues.length} capability contract issue${issues.length === 1 ? "" : "s"}.\n\n`,
    );
    for (const issue of issues) {
      process.stderr.write(`  ${issue.file}\n    ${issue.message}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    update
      ? "[eve:extension-contracts] updated current capability reports.\n"
      : "[eve:extension-contracts] ok — capability epochs and support reports match.\n",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
