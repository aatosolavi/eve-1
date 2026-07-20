import { describe, expect, it } from "vitest";

import { parseRunnerConfig } from "./config.js";

const FULL_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
const TEST_VERCEL_ENVIRONMENT = "development";
const TEST_VERCEL_OIDC_TOKEN = testVercelOidcToken({
  environment: TEST_VERCEL_ENVIRONMENT,
  project_id: "prj_benchmark",
});
const TEST_VERCEL_PROJECT_ID = "prj_benchmark";

describe("parseRunnerConfig", () => {
  it("applies the local defaults", () => {
    expect(parseRunnerConfig({ argv: [], environment: {}, mode: "local" })).toEqual({
      measuredBlocks: 30,
      modelKind: "deterministic",
      mode: "local",
      seed: 1,
      warmupBlocks: 3,
    });
  });

  it("parses explicit counts and seed", () => {
    expect(
      parseRunnerConfig({
        argv: ["--warmups", "0", "--blocks", "5", "--seed", "4294967295"],
        environment: {},
        mode: "local",
      }),
    ).toEqual({
      measuredBlocks: 5,
      modelKind: "deterministic",
      mode: "local",
      seed: 4_294_967_295,
      warmupBlocks: 0,
    });
  });

  it("accepts the argument separator forwarded by pnpm", () => {
    expect(
      parseRunnerConfig({
        argv: ["--", "--warmups", "0", "--blocks", "5"],
        environment: {},
        mode: "local",
      }),
    ).toMatchObject({ measuredBlocks: 5, warmupBlocks: 0 });
  });

  it("defaults hosted runs to the deployed Workflow benchmark", () => {
    expect(
      parseRunnerConfig({
        argv: [],
        environment: { VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN },
        mode: "hosted",
      }),
    ).toMatchObject({
      mode: "hosted",
      runtimeKind: "workflow",
      targetUrl: "https://loop-backend-benchmark-preview.playground-vercel.tools",
      vercelOidcToken: TEST_VERCEL_OIDC_TOKEN,
    });
  });

  it("selects one hosted runtime from its runtime-specific URL flag", () => {
    expect(
      parseRunnerConfig({
        argv: ["--workflow-url", "https://workflow.example/"],
        environment: { VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN },
        mode: "hosted",
      }),
    ).toMatchObject({
      mode: "hosted",
      runtimeKind: "workflow",
      targetUrl: "https://workflow.example",
      vercelOidcToken: TEST_VERCEL_OIDC_TOKEN,
    });
  });

  it("selects one hosted runtime from its runtime-specific URL environment variable", () => {
    expect(
      parseRunnerConfig({
        argv: [],
        environment: {
          EVE_LOOP_BENCHMARK_TEMPORAL_URL: "https://temporal.example",
          VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN,
        },
        mode: "hosted",
      }),
    ).toMatchObject({
      mode: "hosted",
      runtimeKind: "temporal",
      targetUrl: "https://temporal.example",
    });
  });

  it("parses the deterministic Sandbox lane with target auth but no model credential", () => {
    expect(
      parseRunnerConfig({
        argv: ["--git-revision", FULL_COMMIT_SHA.toUpperCase()],
        environment: { VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN },
        mode: "sandbox",
      }),
    ).toEqual({
      gitRevision: FULL_COMMIT_SHA,
      gitUrl: "https://github.com/vercel/eve.git",
      measuredBlocks: 30,
      modelKind: "deterministic",
      mode: "sandbox",
      seed: 1,
      vercelOidc: {
        environment: TEST_VERCEL_ENVIRONMENT,
        projectId: TEST_VERCEL_PROJECT_ID,
        token: TEST_VERCEL_OIDC_TOKEN,
      },
      warmupBlocks: 3,
    });
  });

  it("requires and preserves the live model credential", () => {
    expect(
      parseRunnerConfig({
        argv: ["--git-revision", FULL_COMMIT_SHA],
        environment: {
          EVE_LOOP_BENCHMARK_MODEL_KIND: "live",
          VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN,
        },
        mode: "sandbox",
      }),
    ).toMatchObject({
      modelCredential: { name: "VERCEL_OIDC_TOKEN", value: TEST_VERCEL_OIDC_TOKEN },
      modelKind: "live",
    });
  });

  it("does not forward an SDK OIDC token as a deterministic model credential", () => {
    const config = parseRunnerConfig({
      argv: ["--git-revision", FULL_COMMIT_SHA],
      environment: { VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN },
      mode: "sandbox",
    });

    expect(config).toMatchObject({
      modelKind: "deterministic",
      vercelOidc: {
        environment: TEST_VERCEL_ENVIRONMENT,
        projectId: TEST_VERCEL_PROJECT_ID,
        token: TEST_VERCEL_OIDC_TOKEN,
      },
    });
    expect(config).not.toHaveProperty("modelCredential");
  });

  it("accepts an authenticated private source without accepting secrets as flags", () => {
    expect(
      parseRunnerConfig({
        argv: [
          "--git-url",
          "https://github.example/acme/eve.git",
          "--git-username",
          "benchmark-bot",
          "--git-revision",
          FULL_COMMIT_SHA,
        ],
        environment: {
          EVE_LOOP_BENCHMARK_GIT_TOKEN: "git-test-token",
          VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN,
        },
        mode: "sandbox",
      }),
    ).toMatchObject({
      gitToken: "git-test-token",
      gitUrl: "https://github.example/acme/eve.git",
      gitUsername: "benchmark-bot",
      mode: "sandbox",
    });

    expect(() =>
      parseRunnerConfig({
        argv: ["--git-token", "must-not-be-accepted"],
        environment: {},
        mode: "sandbox",
      }),
    ).toThrow("Unknown benchmark flag: --git-token");
    expect(() =>
      parseRunnerConfig({
        argv: ["--ai-gateway-api-key", "must-not-be-accepted"],
        environment: {},
        mode: "sandbox",
      }),
    ).toThrow("Unknown benchmark flag: --ai-gateway-api-key");
  });

  it.each([
    {
      environment: {},
      message: "EVE_LOOP_BENCHMARK_GIT_REVISION",
    },
    {
      argv: ["--git-revision", "main"],
      environment: {},
      message: "full 40-character commit SHA",
    },
    {
      argv: ["--git-revision", FULL_COMMIT_SHA],
      environment: {},
      message: "VERCEL_OIDC_TOKEN",
    },
    {
      argv: ["--git-revision", FULL_COMMIT_SHA, "--git-username", "benchmark-bot"],
      environment: {},
      message: "EVE_LOOP_BENCHMARK_GIT_TOKEN",
    },
    {
      argv: ["--git-revision", FULL_COMMIT_SHA],
      environment: {
        EVE_LOOP_BENCHMARK_GIT_TOKEN: "git-test-token",
      },
      message: "EVE_LOOP_BENCHMARK_GIT_USERNAME",
    },
  ])(
    "rejects incomplete Sandbox configuration: $message",
    ({ argv = [], environment, message }) => {
      expect(() => parseRunnerConfig({ argv, environment, mode: "sandbox" })).toThrow(message);
    },
  );

  it.each([
    "http://github.com/vercel/eve.git",
    "https://user:secret@github.com/vercel/eve.git",
    "https://github.com/",
    "https://github.com/vercel/eve.git?ref=main",
  ])("rejects a Sandbox Git URL outside the HTTPS repository contract: %s", (gitUrl) => {
    expect(() =>
      parseRunnerConfig({
        argv: ["--git-revision", FULL_COMMIT_SHA, "--git-url", gitUrl],
        environment: {},
        mode: "sandbox",
      }),
    ).toThrow("--git-url must be");
  });

  it.each([
    { argv: ["--blocks", "0"], message: "--blocks must be" },
    { argv: ["--warmups", "-1"], message: "--warmups must be" },
    { argv: ["--seed", "1.5"], message: "--seed must be" },
    { argv: ["--wat", "1"], message: "Unknown benchmark flag" },
    { argv: ["--blocks"], message: "Expected a value" },
    { argv: ["--blocks", "1", "--blocks", "2"], message: "provided more than once" },
    { argv: ["--inline-url", "https://inline.example"], message: "Hosted runtime URL flags" },
  ])("rejects invalid local arguments: $message", ({ argv, message }) => {
    expect(() => parseRunnerConfig({ argv, environment: {}, mode: "local" })).toThrow(message);
  });

  it.each([
    "http://inline.example",
    "https://user:inline@inline.example",
    "https://inline.example/path",
    "https://inline.example?query=1",
    "not-a-url",
  ])("rejects a hosted URL outside the HTTPS-origin contract: %s", (inlineUrl) => {
    expect(() =>
      parseRunnerConfig({
        argv: ["--inline-url", inlineUrl],
        environment: { VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN },
        mode: "hosted",
      }),
    ).toThrow("--inline-url must be");
  });

  it("rejects multiple hosted origins", () => {
    expect(() =>
      parseRunnerConfig({
        argv: [
          "--inline-url",
          "https://inline.example",
          "--workflow-url",
          "https://workflow.example",
        ],
        environment: { VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN },
        mode: "hosted",
      }),
    ).toThrow(
      "Provide at most one of --inline-url, --workflow-url, or --temporal-url; received --inline-url, --workflow-url",
    );
  });

  it("requires Vercel OIDC auth for a hosted target", () => {
    expect(() =>
      parseRunnerConfig({
        argv: ["--workflow-url", "https://workflow.example"],
        environment: {},
        mode: "hosted",
      }),
    ).toThrow("VERCEL_OIDC_TOKEN");
  });

  it("rejects a hosted seed because separate hosted runs are not paired blocks", () => {
    expect(() =>
      parseRunnerConfig({
        argv: ["--workflow-url", "https://workflow.example", "--seed", "7"],
        environment: { VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN },
        mode: "hosted",
      }),
    ).toThrow("--seed cannot be used by the hosted benchmark command");
  });

  it("rejects multiple hosted origins supplied across flags and environment", () => {
    expect(() =>
      parseRunnerConfig({
        argv: ["--workflow-url", "https://workflow.example"],
        environment: {
          EVE_LOOP_BENCHMARK_INLINE_URL: "https://inline.example",
          VERCEL_OIDC_TOKEN: TEST_VERCEL_OIDC_TOKEN,
        },
        mode: "hosted",
      }),
    ).toThrow("received --inline-url, --workflow-url");
  });

  it.each([
    { token: "not-a-jwt" },
    { token: testVercelOidcToken({ environment: TEST_VERCEL_ENVIRONMENT }) },
    { token: testVercelOidcToken({ project_id: TEST_VERCEL_PROJECT_ID }) },
  ])("rejects a Sandbox OIDC token without project binding claims", ({ token }) => {
    expect(() =>
      parseRunnerConfig({
        argv: ["--git-revision", FULL_COMMIT_SHA],
        environment: { VERCEL_OIDC_TOKEN: token },
        mode: "sandbox",
      }),
    ).toThrow("project_id and environment claims");
  });

  it("rejects an invalid model kind in every mode", () => {
    expect(() =>
      parseRunnerConfig({
        argv: [],
        environment: { EVE_LOOP_BENCHMARK_MODEL_KIND: "gateway" },
        mode: "local",
      }),
    ).toThrow('EVE_LOOP_BENCHMARK_MODEL_KIND must be "deterministic" or "live"');
  });
});

function testVercelOidcToken(payload: Readonly<Record<string, string>>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "test-signature",
  ].join(".");
}
