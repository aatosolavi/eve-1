import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { DynamicSkillManifestKey, SandboxKey } from "#context/keys.js";
import { createSandboxSkillHandle } from "#runtime/skills/sandbox-access.js";
import type { ResolvedSkillDefinition, ResolvedToolDefinition } from "#runtime/types.js";

const MARKDOWN_PATH_PATTERN = /\.md$/iu;

type ReadSkillFileInput = z.infer<typeof READ_SKILL_FILE_INPUT_SCHEMA>;

export const READ_SKILL_FILE_INPUT_SCHEMA = z.strictObject({
  path: z.string().describe("Relative path to a Markdown file inside the skill package."),
  skill: z.string().describe("Available skill name or id."),
});
export const READ_SKILL_FILE_OUTPUT_SCHEMA = z.string();

function assertSafeMarkdownPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    !MARKDOWN_PATH_PATTERN.test(path) ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("Expected a relative Markdown path inside the skill package.");
  }
}

async function executeReadSkillFile(
  input: ReadSkillFileInput,
  authoredSkills: readonly ResolvedSkillDefinition[],
): Promise<string> {
  assertSafeMarkdownPath(input.path);
  const ctx = loadContext();
  const dynamicSkillNames = Object.values(ctx.get(DynamicSkillManifestKey) ?? {})
    .flat()
    .map((skill) => skill.name);

  if (dynamicSkillNames.includes(input.skill)) {
    const access = ctx.get(SandboxKey);
    if (access === undefined) {
      throw new Error(`The dynamic skill "${input.skill}" requires sandbox access.`);
    }
    return await createSandboxSkillHandle(access, input.skill).file(input.path).text();
  }

  const skill = authoredSkills.find((entry) => entry.name === input.skill);
  if (skill === undefined) {
    throw new Error(`No skill named "${input.skill}".`);
  }

  const content =
    skill.sourceKind === "skill-package" ? skill.markdownFiles?.[input.path] : undefined;
  if (content === undefined) {
    throw new Error(`Skill file not found: ${input.skill}/${input.path}`);
  }
  return content;
}

const READ_SKILL_FILE_METADATA = {
  description:
    "Read a Markdown file referenced by a loaded skill. Paths are relative to that skill's SKILL.md directory.",
  inputSchema: READ_SKILL_FILE_INPUT_SCHEMA,
  logicalPath: "eve:framework/read-skill-file",
  name: "read_skill_file",
  outputSchema: READ_SKILL_FILE_OUTPUT_SCHEMA,
  sourceId: "eve:read-skill-file-tool",
  sourceKind: "module" as const,
};

/** Creates a node-specific skill file reader with authored skills bound into its executor. */
export function createReadSkillFileToolDefinition(
  authoredSkills: readonly ResolvedSkillDefinition[],
): ResolvedToolDefinition {
  return {
    ...READ_SKILL_FILE_METADATA,
    execute: (input) => executeReadSkillFile(input as ReadSkillFileInput, authoredSkills),
  };
}

export const READ_SKILL_FILE_TOOL_DEFINITION = createReadSkillFileToolDefinition([]);
