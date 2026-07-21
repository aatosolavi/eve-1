import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function currentSnapshot(root) {
  return {
    snapshot: "current",
    gitRef: "HEAD",
    gitSha: git(root, ["rev-parse", "HEAD"]),
    dirty: git(root, ["status", "--porcelain"]) !== "",
  };
}

export function resolveReference(root, gitRef) {
  try {
    return {
      snapshot: "reference",
      gitRef,
      gitSha: git(root, ["rev-parse", "--verify", "--end-of-options", `${gitRef}^{commit}`]),
      dirty: false,
    };
  } catch {
    throw new Error(`Unable to resolve comparison Git ref: ${gitRef}`);
  }
}

/** Builds a package containing current runtime code and documentation from a Git ref. */
export function prepareReferencePackage({ root, tarballPath, outputPath, reference }) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eve-eval-compare-"));
  const archivePath = path.join(temporaryRoot, "reference.tar");
  const referenceRoot = path.join(temporaryRoot, "reference");
  const packageRoot = path.join(temporaryRoot, "package");
  fs.mkdirSync(referenceRoot);
  fs.mkdirSync(packageRoot);

  try {
    execFileSync(
      "git",
      [
        "archive",
        "--format=tar",
        `--output=${archivePath}`,
        reference.gitSha,
        "docs",
        "skills/eve/SKILL.md",
      ],
      { cwd: root },
    );
    execFileSync("tar", ["-xf", archivePath, "-C", referenceRoot]);
    execFileSync("tar", ["-xzf", tarballPath, "-C", packageRoot]);

    const extractedPackage = path.join(packageRoot, "package");
    fs.rmSync(path.join(extractedPackage, "docs"), { recursive: true, force: true });
    fs.cpSync(path.join(referenceRoot, "docs"), path.join(extractedPackage, "docs"), {
      recursive: true,
    });

    const outputDirectory = path.dirname(outputPath);
    const output = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--silent", "--pack-destination", outputDirectory],
      { cwd: extractedPackage, encoding: "utf8" },
    );
    const produced = output.trim().split("\n").pop();
    if (produced === undefined) {
      throw new Error("npm pack did not report a reference tarball path.");
    }
    fs.rmSync(outputPath, { force: true });
    fs.renameSync(path.join(outputDirectory, produced), outputPath);

    return {
      skillPath: path.join(referenceRoot, "skills/eve/SKILL.md"),
      cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
