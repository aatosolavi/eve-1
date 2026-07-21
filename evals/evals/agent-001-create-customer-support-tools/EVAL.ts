import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

const root = process.cwd();
const toolsDir = join(root, "agent", "tools");

function readTool(name: string): string {
  const toolPath = join(toolsDir, `${name}.ts`);
  expect(existsSync(toolPath), `Expected ${toolPath} to exist`).toBe(true);
  return readFileSync(toolPath, "utf8");
}

test("defines both tools at their path-derived names", () => {
  for (const name of ["lookup_order", "issue_refund"]) {
    const source = readTool(name);
    expect(source).toMatch(/import\s*\{[^}]*defineTool[^}]*\}\s*from\s*["']eve\/tools["']/);
    expect(source).toMatch(/export\s+default\s+defineTool\s*\(/);
  }
});

test("looks up an order without requiring approval", () => {
  const source = readTool("lookup_order");

  expect(source).toMatch(/orderId\s*:\s*z\.string\s*\(/);
  expect(source).toMatch(/status\s*:\s*["']paid["']/);
  expect(source).toMatch(/total\s*:\s*125\b/);

  const omitsApproval = !/\bapproval\s*:/.test(source);
  const explicitlySkipsApproval =
    /import\s*\{[^}]*never[^}]*\}\s*from\s*["']eve\/tools\/approval["']/.test(source) &&
    /approval\s*:\s*never\s*\(\s*\)/.test(source);
  expect(omitsApproval || explicitlySkipsApproval).toBe(true);
});

test("issues a refund only after approval", () => {
  const source = readTool("issue_refund");

  expect(source).toMatch(/orderId\s*:\s*z\.string\s*\(/);
  expect(source).toMatch(/amount\s*:\s*z\.number\s*\(\s*\)\.positive\s*\(\s*\)/);
  expect(source).toMatch(/status\s*:\s*["']refunded["']/);
  expect(source).toMatch(/\bamount\b/);
  expect(source).toMatch(/import\s*\{[^}]*always[^}]*\}\s*from\s*["']eve\/tools\/approval["']/);
  expect(source).toMatch(/approval\s*:\s*always\s*\(\s*\)/);
});

test("instructs the agent to look up the order before refunding it", () => {
  const instructions = readFileSync(join(root, "agent", "instructions.md"), "utf8");

  expect(instructions).toMatch(/look\s*up|lookup/i);
  expect(instructions).toMatch(/before[\s\S]*refund/i);
  expect(instructions).toMatch(/approv/i);
});
