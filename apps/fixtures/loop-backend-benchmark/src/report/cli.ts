import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBenchmarkReportInputs } from "./model.js";
import { renderBenchmarkReportHtml } from "./render-html.js";

type ReportOutput = { readonly kind: "stdout" } | { readonly kind: "file"; readonly path: string };

export type ReportArguments =
  | { readonly kind: "help" }
  | {
      readonly inputPaths: readonly string[];
      readonly kind: "render";
      readonly output: ReportOutput;
    };

/** Parses the offline report CLI without reading benchmark files. */
export function parseReportArguments(argv: readonly string[]): ReportArguments {
  const inputPaths: string[] = [];
  let output: ReportOutput = { kind: "stdout" };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument === "--") continue;

    if (argument === "--output" || argument === "-o") {
      const path = argv[index + 1];
      if (path === undefined || path.startsWith("-")) {
        throw new Error(`Missing value for "${argument}".`);
      }
      output = { kind: "file", path };
      index += 1;
      continue;
    }

    if (argument.startsWith("-")) throw new Error(`Unknown argument "${argument}".`);
    inputPaths.push(argument);
  }

  if (inputPaths.length === 0) {
    throw new Error("Expected at least one benchmark JSONL input path.");
  }
  return { inputPaths, kind: "render", output };
}

async function main(argv: readonly string[]): Promise<void> {
  const argumentsResult = parseReportArguments(argv);
  if (argumentsResult.kind === "help") {
    process.stdout.write(usage());
    return;
  }

  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  const inputFiles = argumentsResult.inputPaths.map((path) => ({
    label: basename(path),
    path: resolve(invocationDirectory, path),
  }));
  const inputs = await Promise.all(
    inputFiles.map(async (input) => ({
      label: input.label,
      text: await readFile(input.path, "utf8"),
    })),
  );
  const html = renderBenchmarkReportHtml(parseBenchmarkReportInputs(inputs));

  if (argumentsResult.output.kind === "stdout") {
    process.stdout.write(html);
    return;
  }

  const outputPath = resolve(invocationDirectory, argumentsResult.output.path);
  if (inputFiles.some((input) => input.path === outputPath)) {
    throw new Error(`Refusing to overwrite benchmark input ${JSON.stringify(outputPath)}.`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, "utf8");
  process.stderr.write(`Wrote ${outputPath}\n`);
}

function usage(): string {
  return [
    "Usage: pnpm benchmark:report [options] <results.jsonl> [more-results.jsonl...]",
    "",
    "Options:",
    "  -o, --output <path>  Write self-contained HTML to a file instead of stdout",
    "  -h, --help           Show this help",
    "",
  ].join("\n");
}

const executedScriptPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
const moduleScriptPath = resolve(fileURLToPath(import.meta.url));
if (executedScriptPath === moduleScriptPath) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
