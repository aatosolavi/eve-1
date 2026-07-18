import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
export const EVE_ROOT = join(REPO_ROOT, "packages/eve");
export const COMPATIBILITY_SOURCE = join(EVE_ROOT, "src/compiler/extension-compatibility.ts");
export const CONTRACT_ROOT = join(EVE_ROOT, "extension-contracts");
export const ENTRYPOINT_ROOT = join(CONTRACT_ROOT, "entrypoints");
export const COMPATIBILITY_FIXTURE_ROOT = join(CONTRACT_ROOT, "compatibility");
export const REPORT_ROOT = join(CONTRACT_ROOT, "reports");

const PUBLIC_SURFACES = [
  { path: "src/public/extension/index.ts", capabilities: ["extension", "config"] },
  { path: "src/public/tools/index.ts", capabilities: ["tool", "dynamicTool"] },
  { path: "src/public/connections/index.ts", capabilities: ["connection"] },
  { path: "src/public/hooks/index.ts", capabilities: ["hook"] },
  { path: "src/public/skills/index.ts", capabilities: ["skill", "dynamicSkill"] },
  {
    path: "src/public/instructions/index.ts",
    capabilities: ["instructions", "dynamicInstructions"],
  },
  { path: "src/public/context/index.ts", capabilities: ["state"] },
];

export function toPosix(path) {
  return sep === "/" ? path : path.split(sep).join("/");
}

function extractObjectLiteral(source, constantName) {
  const declaration = source.indexOf(constantName);
  if (declaration === -1) throw new Error(`Could not find ${constantName}.`);
  const assignment = source.indexOf("=", declaration + constantName.length);
  const start = source.indexOf("{", assignment);
  if (assignment === -1 || start === -1) {
    throw new Error(`Could not read ${constantName}'s object literal.`);
  }

  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(start + 1, index);
    }
  }
  throw new Error(`Could not find the end of ${constantName}'s object literal.`);
}

export function parseCapabilityConfiguration(source) {
  const currentBody = extractObjectLiteral(source, "EXTENSION_CAPABILITY_VERSIONS");
  const current = Object.fromEntries(
    [...currentBody.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*(\d+),?\s*$/gm)].map(
      ([, capability, version]) => [capability, Number(version)],
    ),
  );
  const additionalBody = extractObjectLiteral(source, "ADDITIONAL_SUPPORTED_CAPABILITY_VERSIONS");
  const additional = Object.fromEntries(
    [...additionalBody.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*\[([^\]]*)\],?\s*$/gm)].map(
      ([, capability, versions]) => [
        capability,
        versions
          .split(",")
          .map((version) => version.trim())
          .filter(Boolean)
          .map(Number),
      ],
    ),
  );
  const support = Object.fromEntries(
    Object.entries(current).map(([capability, version]) => [
      capability,
      [...(additional[capability] ?? []), version],
    ]),
  );
  return { additional, current, support };
}

export function collectExportNames(source) {
  const names = new Set();
  for (const match of source.matchAll(
    /export\s+(?:type\s+)?\{([\s\S]*?)\}(?:\s+from\s+["'][^"']+["'])?\s*;/g,
  )) {
    for (const rawSpecifier of match[1].split(",")) {
      const specifier = rawSpecifier.trim().replace(/^type\s+/, "");
      if (specifier === "") continue;
      const alias = specifier.split(/\s+as\s+/);
      names.add(alias.at(-1).trim());
    }
  }
  for (const match of source.matchAll(
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|class|function|interface|type)\s+([A-Za-z][A-Za-z0-9]*)/g,
  )) {
    names.add(match[1]);
  }
  return names;
}

export async function validateCapabilityConfiguration(configuration) {
  const issues = [];
  const capabilities = Object.keys(configuration.current);
  const entrypointEntries = await readdir(ENTRYPOINT_ROOT, { withFileTypes: true });
  const entrypointCapabilities = entrypointEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();

  for (const capability of capabilities) {
    const version = configuration.current[capability];
    const supported = configuration.support[capability];
    if (!Number.isInteger(version) || version < 1) {
      issues.push({
        file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
        message: `Capability "${capability}" must have a positive integer epoch.`,
      });
    }
    if (!supported.includes(version)) {
      issues.push({
        file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
        message: `Capability "${capability}" does not list its current epoch ${version} as supported.`,
      });
    }
    if (new Set(supported).size !== supported.length) {
      issues.push({
        file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
        message: `Capability "${capability}" lists a supported epoch more than once.`,
      });
    }
    for (const supportedVersion of supported) {
      if (
        !Number.isInteger(supportedVersion) ||
        supportedVersion < 1 ||
        supportedVersion > version
      ) {
        issues.push({
          file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
          message: `Capability "${capability}" has invalid supported epoch ${supportedVersion}; supported epochs must be positive and no newer than current epoch ${version}.`,
        });
      }
    }
  }

  for (const [capability, versions] of Object.entries(configuration.additional)) {
    if (!Object.hasOwn(configuration.current, capability)) {
      issues.push({
        file: toPosix(relative(REPO_ROOT, COMPATIBILITY_SOURCE)),
        message: `Additional support is configured for unknown capability "${capability}".`,
      });
      continue;
    }
    for (const version of versions) {
      const fixturePath = join(COMPATIBILITY_FIXTURE_ROOT, capability, `v${version}.ts`);
      try {
        await readFile(fixturePath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          issues.push({
            file: toPosix(relative(REPO_ROOT, fixturePath)),
            message: `Advertising ${capability} epoch ${version} requires an immutable compatibility fixture that exercises the retained authoring contract.`,
          });
          continue;
        }
        throw error;
      }
    }
  }

  const configured = [...capabilities].sort();
  if (JSON.stringify(configured) !== JSON.stringify(entrypointCapabilities)) {
    issues.push({
      file: toPosix(relative(REPO_ROOT, ENTRYPOINT_ROOT)),
      message: `Contract entrypoints must exactly match configured capabilities. Expected ${configured.join(", ")}; found ${entrypointCapabilities.join(", ")}.`,
    });
  }

  for (const surface of PUBLIC_SURFACES) {
    const publicSource = await readFile(join(EVE_ROOT, surface.path), "utf8");
    const publicNames = collectExportNames(publicSource);
    const contractNames = new Set();
    for (const capability of surface.capabilities) {
      const contractSource = await readFile(join(ENTRYPOINT_ROOT, `${capability}.ts`), "utf8");
      for (const name of collectExportNames(contractSource)) contractNames.add(name);
    }
    const missing = [...publicNames].filter((name) => !contractNames.has(name)).sort();
    const extra = [...contractNames].filter((name) => !publicNames.has(name)).sort();
    if (missing.length > 0 || extra.length > 0) {
      const details = [
        missing.length > 0 ? `unassigned exports: ${missing.join(", ")}` : "",
        extra.length > 0 ? `unknown exports: ${extra.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      issues.push({
        file: toPosix(relative(REPO_ROOT, join(EVE_ROOT, surface.path))),
        message: `Capability contract coverage is incomplete (${details}). Assign every public export to one of: ${surface.capabilities.join(", ")}.`,
      });
    }
  }

  return issues;
}
