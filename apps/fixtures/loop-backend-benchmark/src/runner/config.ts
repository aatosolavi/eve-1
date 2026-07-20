import { Buffer } from "node:buffer";

import type { BenchmarkRuntimeKind } from "../driver/index.js";
import {
  BENCHMARK_MODEL_KIND_ENV,
  parseBenchmarkModelKind,
  type BenchmarkModelKind,
} from "../model-kind.js";

const DEFAULT_MEASURED_BLOCKS = 30;
const DEFAULT_SEED = 1;
const DEFAULT_WARMUP_BLOCKS = 3;
const DEFAULT_GIT_URL = "https://github.com/vercel/eve.git";
const DEFAULT_HOSTED_WORKFLOW_ORIGIN =
  "https://loop-backend-benchmark-preview.playground-vercel.tools";

const AI_GATEWAY_API_KEY_ENV = "AI_GATEWAY_API_KEY";
const GIT_REVISION_ENV = "EVE_LOOP_BENCHMARK_GIT_REVISION";
const GIT_TOKEN_ENV = "EVE_LOOP_BENCHMARK_GIT_TOKEN";
const GIT_URL_ENV = "EVE_LOOP_BENCHMARK_GIT_URL";
const GIT_USERNAME_ENV = "EVE_LOOP_BENCHMARK_GIT_USERNAME";
const VERCEL_OIDC_TOKEN_ENV = "VERCEL_OIDC_TOKEN";

export type SandboxModelCredential =
  | { readonly name: typeof AI_GATEWAY_API_KEY_ENV; readonly value: string }
  | { readonly name: typeof VERCEL_OIDC_TOKEN_ENV; readonly value: string };

interface SandboxVercelOidc {
  readonly environment: string;
  readonly projectId: string;
  readonly token: string;
}

const URL_ENVIRONMENT_VARIABLES = {
  inline: "EVE_LOOP_BENCHMARK_INLINE_URL",
  temporal: "EVE_LOOP_BENCHMARK_TEMPORAL_URL",
  workflow: "EVE_LOOP_BENCHMARK_WORKFLOW_URL",
} satisfies Record<BenchmarkRuntimeKind, string>;

type RunnerMode = "hosted" | "local" | "sandbox";

export type ParsedRunnerConfig =
  | {
      readonly measuredBlocks: number;
      readonly modelKind: BenchmarkModelKind;
      readonly mode: "hosted";
      readonly runtimeKind: BenchmarkRuntimeKind;
      readonly targetUrl: string;
      readonly vercelOidcToken: string;
      readonly warmupBlocks: number;
    }
  | {
      readonly measuredBlocks: number;
      readonly modelKind: BenchmarkModelKind;
      readonly mode: "local";
      readonly seed: number;
      readonly warmupBlocks: number;
    }
  | ({
      readonly gitRevision: string;
      readonly gitUrl: string;
      readonly measuredBlocks: number;
      readonly mode: "sandbox";
      readonly seed: number;
      readonly vercelOidc: SandboxVercelOidc;
      readonly warmupBlocks: number;
    } & (
      | {
          readonly modelCredential?: never;
          readonly modelKind: "deterministic";
        }
      | {
          readonly modelCredential: SandboxModelCredential;
          readonly modelKind: "live";
        }
    ) &
      (
        | {
            readonly gitToken?: never;
            readonly gitUsername?: never;
          }
        | {
            readonly gitToken: string;
            readonly gitUsername: string;
          }
      ));

interface ParsedFlags {
  readonly blocks?: string;
  readonly gitRevision?: string;
  readonly gitUrl?: string;
  readonly gitUsername?: string;
  readonly inlineUrl?: string;
  readonly seed?: string;
  readonly temporalUrl?: string;
  readonly warmups?: string;
  readonly workflowUrl?: string;
}

interface HostedTargetCandidate {
  readonly environmentName: string;
  readonly flag: string;
  readonly raw: string | undefined;
  readonly runtimeKind: BenchmarkRuntimeKind;
}

export function parseRunnerConfig(input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly mode: RunnerMode;
}): ParsedRunnerConfig {
  const flags = parseFlags(input.argv);
  const common = {
    measuredBlocks: parseCount(flags.blocks, DEFAULT_MEASURED_BLOCKS, "--blocks", 1),
    modelKind: parseBenchmarkModelKind(input.environment[BENCHMARK_MODEL_KIND_ENV]),
    warmupBlocks: parseCount(flags.warmups, DEFAULT_WARMUP_BLOCKS, "--warmups", 0),
  };

  if (input.mode === "local") {
    rejectHostedFlags(flags, "local");
    rejectSandboxFlags(flags, "local");
    return { ...common, mode: "local", seed: parseSeed(flags.seed) };
  }

  if (input.mode === "sandbox") {
    rejectHostedFlags(flags, "sandbox");
    const gitUsername = parseOptionalText(
      flags.gitUsername ?? input.environment[GIT_USERNAME_ENV],
      "--git-username",
    );
    const gitToken = parseOptionalCredential(input.environment[GIT_TOKEN_ENV]);
    if (gitUsername !== undefined && gitToken === undefined) {
      throw new Error(`Set ${GIT_TOKEN_ENV} when a private Git username is configured.`);
    }
    if (gitUsername === undefined && gitToken !== undefined) {
      throw new Error(`Set ${GIT_USERNAME_ENV} or pass --git-username with ${GIT_TOKEN_ENV}.`);
    }

    const sandboxCommon = {
      ...common,
      gitRevision: parseGitRevision(flags.gitRevision ?? input.environment[GIT_REVISION_ENV]),
      gitUrl: parseGitUrl(flags.gitUrl ?? input.environment[GIT_URL_ENV] ?? DEFAULT_GIT_URL),
      mode: "sandbox" as const,
      seed: parseSeed(flags.seed),
      vercelOidc: parseSandboxVercelOidc(input.environment[VERCEL_OIDC_TOKEN_ENV]),
    };
    const sandboxConfig =
      common.modelKind === "live"
        ? {
            ...sandboxCommon,
            modelCredential: parseModelCredential(input.environment),
            modelKind: "live" as const,
          }
        : { ...sandboxCommon, modelKind: "deterministic" as const };
    if (gitUsername === undefined || gitToken === undefined) return sandboxConfig;
    return { ...sandboxConfig, gitToken, gitUsername };
  }

  rejectSandboxFlags(flags, "hosted");
  if (flags.seed !== undefined) {
    throw new Error("--seed cannot be used by the hosted benchmark command.");
  }
  const target = parseHostedTarget(flags, input.environment);
  return {
    ...common,
    mode: "hosted",
    ...target,
    vercelOidcToken: parseHostedVercelOidcToken(input.environment[VERCEL_OIDC_TOKEN_ENV]),
  };
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  for (let index = 0; index < normalizedArgv.length; index += 2) {
    const flag = normalizedArgv[index];
    const value = normalizedArgv[index + 1];
    if (flag === undefined || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected a value after ${flag ?? "the final benchmark flag"}.`);
    }
    if (!isKnownFlag(flag)) {
      throw new Error(`Unknown benchmark flag: ${flag}`);
    }
    if (values.has(flag)) {
      throw new Error(`Benchmark flag was provided more than once: ${flag}`);
    }
    values.set(flag, value);
  }

  return {
    blocks: values.get("--blocks"),
    gitRevision: values.get("--git-revision"),
    gitUrl: values.get("--git-url"),
    gitUsername: values.get("--git-username"),
    inlineUrl: values.get("--inline-url"),
    seed: values.get("--seed"),
    temporalUrl: values.get("--temporal-url"),
    warmups: values.get("--warmups"),
    workflowUrl: values.get("--workflow-url"),
  };
}

function isKnownFlag(value: string): boolean {
  return (
    value === "--blocks" ||
    value === "--git-revision" ||
    value === "--git-url" ||
    value === "--git-username" ||
    value === "--inline-url" ||
    value === "--seed" ||
    value === "--temporal-url" ||
    value === "--warmups" ||
    value === "--workflow-url"
  );
}

function rejectHostedFlags(flags: ParsedFlags, mode: RunnerMode): void {
  if (
    flags.inlineUrl !== undefined ||
    flags.temporalUrl !== undefined ||
    flags.workflowUrl !== undefined
  ) {
    throw new Error(`Hosted runtime URL flags cannot be used by the ${mode} benchmark command.`);
  }
}

function rejectSandboxFlags(flags: ParsedFlags, mode: RunnerMode): void {
  if (
    flags.gitRevision !== undefined ||
    flags.gitUrl !== undefined ||
    flags.gitUsername !== undefined
  ) {
    throw new Error(`Sandbox Git flags cannot be used by the ${mode} benchmark command.`);
  }
}

function parseCount(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function parseSeed(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SEED;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("--seed must be an integer between 0 and 4294967295.");
  }
  return value;
}

function parseGitRevision(raw: string | undefined): string {
  if (raw === undefined || !/^[0-9a-f]{40}$/i.test(raw)) {
    throw new Error(
      `Provide --git-revision or ${GIT_REVISION_ENV} as a full 40-character commit SHA.`,
    );
  }
  return raw.toLowerCase();
}

function parseGitUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--git-url must be a valid HTTPS repository URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname === "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "--git-url must be an HTTPS repository URL without credentials, a query, or a hash.",
    );
  }
  return url.toString();
}

function parseOptionalText(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(`${name} cannot be empty.`);
  }
  return value;
}

function parseOptionalCredential(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim().length === 0 ? undefined : raw;
}

function parseSandboxVercelOidc(raw: string | undefined): SandboxVercelOidc {
  const token = parseOptionalCredential(raw)?.trim();
  if (token === undefined) {
    throw new Error(
      `Set ${VERCEL_OIDC_TOKEN_ENV} in the environment to authenticate the Vercel Sandbox and its eve routes.`,
    );
  }

  const claims = decodeJwtPayload(token);
  const projectId = readNonemptyString(claims, "project_id");
  const environment = readNonemptyString(claims, "environment");
  if (projectId === undefined || environment === undefined) {
    throw new Error(
      `${VERCEL_OIDC_TOKEN_ENV} must be a JWT with non-empty project_id and environment claims.`,
    );
  }
  return { environment, projectId, token };
}

function decodeJwtPayload(token: string): Readonly<Record<string, unknown>> | null {
  const segments = token.split(".");
  if (segments.length !== 3 || segments[1] === undefined || segments[1].length === 0) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    return typeof value === "object" && value !== null
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function readNonemptyString(
  record: Readonly<Record<string, unknown>> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function parseModelCredential(
  environment: Readonly<Record<string, string | undefined>>,
): SandboxModelCredential {
  const apiKey = parseOptionalCredential(environment[AI_GATEWAY_API_KEY_ENV]);
  if (apiKey !== undefined) return { name: AI_GATEWAY_API_KEY_ENV, value: apiKey };

  const oidcToken = parseOptionalCredential(environment[VERCEL_OIDC_TOKEN_ENV]);
  if (oidcToken !== undefined) return { name: VERCEL_OIDC_TOKEN_ENV, value: oidcToken };

  throw new Error(`Set ${AI_GATEWAY_API_KEY_ENV} or ${VERCEL_OIDC_TOKEN_ENV} in the environment.`);
}

function parseHostedTarget(
  flags: ParsedFlags,
  environment: Readonly<Record<string, string | undefined>>,
): { readonly runtimeKind: BenchmarkRuntimeKind; readonly targetUrl: string } {
  const candidates = (
    [
      {
        environmentName: URL_ENVIRONMENT_VARIABLES.inline,
        flag: "--inline-url",
        raw: flags.inlineUrl ?? environment[URL_ENVIRONMENT_VARIABLES.inline],
        runtimeKind: "inline",
      },
      {
        environmentName: URL_ENVIRONMENT_VARIABLES.workflow,
        flag: "--workflow-url",
        raw: flags.workflowUrl ?? environment[URL_ENVIRONMENT_VARIABLES.workflow],
        runtimeKind: "workflow",
      },
      {
        environmentName: URL_ENVIRONMENT_VARIABLES.temporal,
        flag: "--temporal-url",
        raw: flags.temporalUrl ?? environment[URL_ENVIRONMENT_VARIABLES.temporal],
        runtimeKind: "temporal",
      },
    ] satisfies readonly HostedTargetCandidate[]
  ).filter((candidate) => candidate.raw !== undefined);

  if (candidates.length === 0) {
    return {
      runtimeKind: "workflow",
      targetUrl: DEFAULT_HOSTED_WORKFLOW_ORIGIN,
    };
  }

  if (candidates.length > 1) {
    const configured = candidates.map((candidate) => candidate.flag).join(", ");
    throw new Error(
      `Provide at most one of --inline-url, --workflow-url, or --temporal-url; received ${configured}.`,
    );
  }

  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new Error("The hosted benchmark target is missing.");
  }
  return {
    runtimeKind: candidate.runtimeKind,
    targetUrl: parseHostedUrl(candidate.raw, candidate.flag, candidate.environmentName),
  };
}

function parseHostedVercelOidcToken(raw: string | undefined): string {
  const token = parseOptionalCredential(raw)?.trim();
  if (token === undefined) {
    throw new Error(
      `Set ${VERCEL_OIDC_TOKEN_ENV} in the environment to authenticate requests to the hosted eve agent.`,
    );
  }
  return token;
}

function parseHostedUrl(raw: string | undefined, flag: string, environmentName: string): string {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error(`Provide ${flag} or ${environmentName}.`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${flag} must be a valid HTTPS origin.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${flag} must be an HTTPS origin without credentials, a path, query, or hash.`);
  }
  return url.origin;
}
