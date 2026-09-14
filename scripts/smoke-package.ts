#!/usr/bin/env bun
/**
 * Packaging smoke test: pack the source tree, install the tarball into a
 * throwaway consumer, then run the installed `woof` binary. Catches
 * entry-point and files-allowlist breakage that a source-tree run cannot see.
 *
 * Unlike the previous iteration, there is no compiled `dist/` in the runtime
 * path: `woof`, `woof-mcp` and `woof-agent-mcp` are bash launchers that exec
 * `bun run src/*.ts` directly, so the tarball ships `src/` alongside `bin/`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPackageJson, repoRoot } from "./lib/metadata.ts";

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${String(result.status)})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

const pkg = await readPackageJson();

for (const required of ["bin/woof", "bin/woof-mcp", "bin/woof-agent-mcp", "src/cli.ts"]) {
  if (!existsSync(join(repoRoot, required))) {
    throw new Error(`${required} missing`);
  }
}

const workDir = mkdtempSync(join(tmpdir(), "woof-smoke-"));
try {
  run("bun", ["pm", "pack", "--destination", workDir], repoRoot);
  const tarball = readdirSync(workDir).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) throw new Error(`no tarball produced in ${workDir}`);

  const shipped = run("tar", ["-tzf", join(workDir, tarball)], workDir)
    .split("\n")
    .filter(Boolean)
    .map((entry) => entry.replace(/^package\//, ""));
  const shippedRootFiles = new Set(["package.json", "README.md"]);
  const strays = shipped.filter(
    (entry) =>
      !entry.startsWith("bin/") && !entry.startsWith("src/") && !shippedRootFiles.has(entry),
  );
  if (strays.length > 0) {
    throw new Error(`tarball ships unexpected files: ${strays.join(", ")}`);
  }
  const required = [
    "package.json",
    "README.md",
    "bin/woof",
    "bin/woof-mcp",
    "bin/woof-agent-mcp",
    "src/cli.ts",
    "src/mcp/woof.ts",
    "src/mcp/agent.ts",
  ];
  const shippedSet = new Set(shipped);
  const missing = required.filter((entry) => !shippedSet.has(entry));
  if (missing.length > 0) {
    throw new Error(`tarball is missing files a release has to carry: ${missing.join(", ")}`);
  }

  const consumer = join(workDir, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "woof-smoke-consumer", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`,
  );
  run("bun", ["add", join(workDir, tarball)], consumer);

  const binary = join(consumer, "node_modules", ".bin", "woof");
  if (!existsSync(binary)) throw new Error(`installed binary missing at ${binary}`);
  const versionOut = run(binary, ["--version"], consumer).trim();
  if (versionOut !== pkg.version) {
    throw new Error(`installed \`woof --version\` printed ${versionOut}, expected ${pkg.version}`);
  }
  const helpOut = run(binary, ["--help"], consumer);
  if (!helpOut.includes("Usage: woof")) {
    throw new Error(`installed \`woof --help\` output unexpected:\n${helpOut}`);
  }

  console.log(
    [
      `packaged ${tarball}`,
      `installed woof --version -> ${versionOut}`,
      "installed woof --help ok",
    ].join("\n"),
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
