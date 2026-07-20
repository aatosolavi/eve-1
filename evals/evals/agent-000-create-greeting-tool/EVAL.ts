import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

const root = process.cwd();
const toolPath = join(root, "agent", "tools", "greet_user.ts");

test("defines the greet_user tool at its path-derived name", () => {
  expect(existsSync(toolPath)).toBe(true);

  const source = readFileSync(toolPath, "utf8");
  expect(source).toMatch(/import\s*\{[^}]*defineTool[^}]*\}\s*from\s*["']eve\/tools["']/);
  expect(source).toMatch(/export\s+default\s+defineTool\s*\(/);
});

test("accepts a required name and returns the requested structured greeting", () => {
  const source = readFileSync(toolPath, "utf8");
  expect(source).toMatch(/inputSchema\s*:/);
  expect(source).toMatch(/name\s*:\s*z\.string\s*\(/);
  expect(source).toMatch(/execute\s*\(/);
  expect(source).toMatch(/Hello,\s*\$\{\s*name\s*\}!/);
  expect(source).toMatch(
    /return\s*\{[^}]*\bname\b[^}]*\bgreeting\b|return\s*\{[^}]*\bgreeting\b[^}]*\bname\b/s,
  );
});

test("tells the agent when to use the greeting tool", () => {
  const instructions = readFileSync(join(root, "agent", "instructions.md"), "utf8");
  expect(instructions).toMatch(/greet|greeting/i);
});
