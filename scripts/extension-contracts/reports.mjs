import { CompilerState, Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  CONTRACT_ROOT,
  ENTRYPOINT_ROOT,
  EVE_ROOT,
  REPORT_ROOT,
  REPO_ROOT,
  collectExportNames,
  toPosix,
} from "./configuration.mjs";

async function* walkFiles(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path);
    if (entry.isFile()) yield path;
  }
}

function relativeModuleSpecifier(fromFile, targetFile) {
  const path = toPosix(relative(dirname(fromFile), targetFile));
  return path.startsWith(".") ? path : `./${path}`;
}

function formatSnapshot(snapshot, snapshotPath) {
  const require = createRequire(import.meta.url);
  const formatterPackage = require.resolve("oxfmt/package.json");
  const formatter = join(dirname(formatterPackage), "bin/oxfmt");
  return execFileSync(process.execPath, [formatter, "--stdin-filepath", snapshotPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    input: snapshot,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function rewriteDeclarationSpecifiers(declarationRoot) {
  for await (const path of walkFiles(declarationRoot)) {
    if (!path.endsWith(".d.ts")) continue;
    const original = await readFile(path, "utf8");
    const rewritten = original
      .replace(/(["'])(#[^"']+)\1/g, (_match, quote, specifier) => {
        const target = specifier.startsWith("#compiled/")
          ? join(declarationRoot, "compiled", specifier.slice("#compiled/".length))
          : join(declarationRoot, "src", specifier.slice(1));
        return `${quote}${relativeModuleSpecifier(path, target)}${quote}`;
      })
      .replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, (_match, quote, specifier) => {
        return `${quote}${specifier}.js${quote}`;
      });
    if (rewritten !== original) await writeFile(path, rewritten, "utf8");
  }
}

async function emitDeclarations(tempRoot) {
  const declarationRoot = join(tempRoot, "declarations");
  await mkdir(declarationRoot, { recursive: true });
  execFileSync(process.execPath, [join(EVE_ROOT, "scripts/vendor-compiled.mjs")], {
    cwd: EVE_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const require = createRequire(import.meta.url);
  const typescriptPackage = require.resolve("typescript/package.json");
  const tsc = join(dirname(typescriptPackage), "bin/tsc");
  execFileSync(
    process.execPath,
    [
      tsc,
      "-p",
      join(CONTRACT_ROOT, "tsconfig.json"),
      "--outDir",
      declarationRoot,
      "--declarationMap",
      "false",
      "--sourceMap",
      "false",
      "--removeComments",
      "true",
      "--pretty",
      "false",
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  await cp(join(EVE_ROOT, ".generated/compiled"), join(declarationRoot, "compiled"), {
    recursive: true,
  });
  await rewriteDeclarationSpecifiers(declarationRoot);

  const packageJson = JSON.parse(await readFile(join(EVE_ROOT, "package.json"), "utf8"));
  packageJson.name = "eve-extension-contracts";
  packageJson.version = "0.0.0";
  packageJson.private = true;
  packageJson.types = "./extension-contracts/entrypoints/extension.d.ts";
  delete packageJson.exports;
  delete packageJson.imports;
  await writeFile(
    join(declarationRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  return declarationRoot;
}

function extractorConfig({ capabilities, capability, declarationRoot, tempRoot }) {
  const reportFolder = join(tempRoot, "generated-reports", capability);
  const reportTempFolder = join(tempRoot, "temporary-reports", capability);
  return {
    reportFolder,
    reportTempFolder,
    config: ExtractorConfig.prepare({
      configObject: {
        projectFolder: declarationRoot,
        mainEntryPointFilePath: join(
          declarationRoot,
          "extension-contracts/entrypoints",
          `${capability}.d.ts`,
        ),
        newlineKind: "lf",
        testMode: true,
        compiler: {
          overrideTsconfig: {
            compilerOptions: {
              lib: ["ES2024", "DOM", "DOM.Iterable"],
              module: "NodeNext",
              moduleResolution: "NodeNext",
              skipLibCheck: true,
              strict: true,
              target: "ES2024",
              types: ["node"],
            },
            files: capabilities.map((name) =>
              join(declarationRoot, "extension-contracts/entrypoints", `${name}.d.ts`),
            ),
          },
          skipLibCheck: true,
        },
        apiReport: {
          enabled: true,
          includeForgottenExports: true,
          reportFileName: "current",
          reportFolder,
          reportTempFolder,
        },
        docModel: { enabled: false },
        dtsRollup: { enabled: false },
        tsdocMetadata: { enabled: false },
        messages: {
          compilerMessageReporting: { default: { logLevel: "error" } },
          extractorMessageReporting: { default: { logLevel: "none" } },
          tsdocMessageReporting: { default: { logLevel: "none" } },
        },
      },
      configObjectFullPath: undefined,
      packageJsonFullPath: join(declarationRoot, "package.json"),
    }),
  };
}

export async function checkCapabilityReports(configuration, update) {
  const issues = [];
  const cacheRoot = join(REPO_ROOT, ".extension-contracts-cache");
  await mkdir(cacheRoot, { recursive: true });
  const tempRoot = await mkdtemp(join(cacheRoot, "extension-contracts-"));
  try {
    const declarationRoot = await emitDeclarations(tempRoot);
    const capabilities = Object.keys(configuration.current);
    const configs = [];
    for (const [capability, version] of Object.entries(configuration.current)) {
      const item = extractorConfig({ capabilities, capability, declarationRoot, tempRoot });
      await mkdir(item.reportFolder, { recursive: true });
      await mkdir(item.reportTempFolder, { recursive: true });
      configs.push({ capability, version, ...item });
    }
    const entrypoints = configs.map((item) => item.config.mainEntryPointFilePath);
    const compilerState = CompilerState.create(configs[0].config, {
      additionalEntryPoints: entrypoints.slice(1),
    });

    for (const item of configs) {
      const messages = [];
      const result = Extractor.invoke(item.config, {
        compilerState,
        localBuild: true,
        printApiReportDiff: false,
        messageCallback(message) {
          if (message.logLevel === "error") messages.push(message.formatMessageWithoutLocation());
          message.handled = true;
        },
      });
      if (!result.succeeded) {
        issues.push({
          file: toPosix(relative(REPO_ROOT, join(REPORT_ROOT, item.capability))),
          message:
            messages[0] ??
            `Could not extract the ${item.capability} API for epoch ${item.version}.`,
        });
        continue;
      }

      const generatedReport = await readFile(join(item.reportFolder, "current.api.md"), "utf8");
      const contractSource = await readFile(join(ENTRYPOINT_ROOT, `${item.capability}.ts`), "utf8");
      const snapshotPath = join(REPORT_ROOT, item.capability, `v${item.version}.json`);
      const snapshot = formatSnapshot(
        JSON.stringify({
          kind: "eve-extension-capability-contract",
          capability: item.capability,
          epoch: item.version,
          sha256: createHash("sha256").update(generatedReport).digest("hex"),
          exports: [...collectExportNames(contractSource)].sort(),
        }),
        snapshotPath,
      );
      let existing;
      try {
        existing = await readFile(snapshotPath, "utf8");
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }

      if (update && existing === undefined) {
        await mkdir(dirname(snapshotPath), { recursive: true });
        await writeFile(snapshotPath, snapshot, "utf8");
      } else if (existing !== snapshot) {
        issues.push({
          file: toPosix(relative(REPO_ROOT, snapshotPath)),
          message: `The ${item.capability} API no longer matches epoch ${item.version}. Bump EXTENSION_CAPABILITY_VERSIONS.${item.capability}, retain the old report, then run \`pnpm update:extension-contracts\` to add the new epoch report.`,
        });
      }
    }
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : undefined;
    issues.push({
      file: toPosix(relative(REPO_ROOT, CONTRACT_ROOT)),
      message: `Could not generate extension capability reports: ${stderr || (error instanceof Error ? error.message : String(error))}`,
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  return issues;
}

export async function reportInventoryIssues(configuration) {
  const issues = [];
  const entries = await readdir(REPORT_ROOT, { withFileTypes: true });
  const reportCapabilities = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const configuredCapabilities = Object.keys(configuration.current).sort();
  if (JSON.stringify(reportCapabilities) !== JSON.stringify(configuredCapabilities)) {
    issues.push({
      file: toPosix(relative(REPO_ROOT, REPORT_ROOT)),
      message: `Report directories must exactly match configured capabilities. Expected ${configuredCapabilities.join(", ")}; found ${reportCapabilities.join(", ")}.`,
    });
  }

  for (const [capability, currentVersion] of Object.entries(configuration.current)) {
    const expectedReportNames = Array.from(
      { length: currentVersion },
      (_, index) => `v${index + 1}.json`,
    ).sort();
    const actualReportNames = (
      await readdir(join(REPORT_ROOT, capability), { withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    if (JSON.stringify(actualReportNames) !== JSON.stringify(expectedReportNames)) {
      issues.push({
        file: toPosix(relative(REPO_ROOT, join(REPORT_ROOT, capability))),
        message: `Capability ${capability} report files must cover every epoch from 1 through ${currentVersion}. Expected ${expectedReportNames.join(", ")}; found ${actualReportNames.join(", ")}.`,
      });
    }
    for (let version = 1; version <= currentVersion; version++) {
      const reportPath = join(REPORT_ROOT, capability, `v${version}.json`);
      try {
        await readFile(reportPath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          issues.push({
            file: toPosix(relative(REPO_ROOT, reportPath)),
            message: `Capability ${capability} is at epoch ${currentVersion}, so immutable report v${version}.json must be retained. Restore the report or bump epochs sequentially and generate the missing report.`,
          });
          continue;
        }
        throw error;
      }
    }
  }
  return issues;
}
