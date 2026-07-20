import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { createReadSkillFileToolDefinition } from "#runtime/framework-tools/read-skill-file.js";
import { createSkillToolDefinition } from "#runtime/framework-tools/skill.js";
import type { ResolvedSkillDefinition } from "#runtime/types.js";

function incidentResponseSkill(): ResolvedSkillDefinition {
  return {
    description: "Run the incident response procedure",
    logicalPath: "skills/incident-response/SKILL.md",
    markdown: "# Incident response\n\nRead `references/triage.md`.\n",
    markdownFiles: {
      "references/services/api/owners.md": "# API owners\n",
      "references/triage.md": "# Triage\n\nRead `services/api/owners.md`.\n",
    },
    name: "incident-response",
    rootPath: "/authored/skills/incident-response",
    skillFilePath: "/authored/skills/incident-response/SKILL.md",
    skillId: "incident-response",
    sourceId: "skills/incident-response/SKILL.md",
    sourceKind: "skill-package",
  };
}

function executor(skills: readonly ResolvedSkillDefinition[] = [incidentResponseSkill()]) {
  const execute = createReadSkillFileToolDefinition(skills).execute;
  if (execute === undefined) throw new Error("read_skill_file is missing an executor");
  return execute;
}

describe("read_skill_file executor", () => {
  it("loads and progressively reads a multi-layer static skill without opening a sandbox", async () => {
    const get = vi.fn(async () => {
      throw new Error("Static skill files must not open a sandbox");
    });
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, {
      captureState: vi.fn(async () => ({ initialized: false, session: null })),
      get,
    });
    const loadSkill = createSkillToolDefinition([incidentResponseSkill()]).execute;
    if (loadSkill === undefined) throw new Error("load_skill is missing an executor");
    const execute = executor();

    await expect(
      contextStorage.run(ctx, () =>
        loadSkill({ skill: "incident-response" }, { messages: [], toolCallId: "call_load_skill" }),
      ),
    ).resolves.toContain("Read `references/triage.md`");
    expect(get).not.toHaveBeenCalled();

    await expect(
      contextStorage.run(ctx, () =>
        execute(
          { path: "references/triage.md", skill: "incident-response" },
          { messages: [], toolCallId: "call_triage" },
        ),
      ),
    ).resolves.toContain("Read `services/api/owners.md`");
    await expect(
      contextStorage.run(ctx, () =>
        execute(
          { path: "references/services/api/owners.md", skill: "incident-response" },
          { messages: [], toolCallId: "call_owners" },
        ),
      ),
    ).resolves.toBe("# API owners\n");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects traversal, absolute, and non-Markdown paths", async () => {
    const ctx = new ContextContainer();
    const execute = executor();

    for (const path of ["../secret.md", "/etc/passwd.md", "references/data.json", "a//b.md"]) {
      await expect(
        contextStorage.run(ctx, () =>
          execute(
            { path, skill: "incident-response" },
            { messages: [], toolCallId: "call_invalid" },
          ),
        ),
      ).rejects.toThrow("Expected a relative Markdown path");
    }
  });

  it("reports missing skills and files", async () => {
    const ctx = new ContextContainer();
    const execute = executor();

    await expect(
      contextStorage.run(ctx, () =>
        execute(
          { path: "references/missing.md", skill: "incident-response" },
          { messages: [], toolCallId: "call_missing_file" },
        ),
      ),
    ).rejects.toThrow("Skill file not found: incident-response/references/missing.md");
    await expect(
      contextStorage.run(ctx, () =>
        execute(
          { path: "references/missing.md", skill: "missing" },
          { messages: [], toolCallId: "call_missing_skill" },
        ),
      ),
    ).rejects.toThrow('No skill named "missing"');
  });

  it("reads an active dynamic override from the sandbox", async () => {
    const sandbox = mockSandbox({
      initialFiles: {
        "/workspace/skills/incident-response/references/triage.md": "# Dynamic triage\n",
      },
    });
    const ctx = new ContextContainer();
    ctx.set(SandboxKey, sandbox.access);
    ctx.set(DynamicSkillManifestKey, {
      dynamic: [{ description: "Dynamic response", name: "incident-response" }],
    });

    await expect(
      contextStorage.run(ctx, () =>
        executor()(
          { path: "references/triage.md", skill: "incident-response" },
          { messages: [], toolCallId: "call_dynamic" },
        ),
      ),
    ).resolves.toBe("# Dynamic triage\n");
  });
});
