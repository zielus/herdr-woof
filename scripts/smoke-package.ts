#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
};

if (!existsSync(join(repoRoot, "dist", "index.js"))) {
  throw new Error("dist/index.js is missing; run bun run build before smoke:package");
}

const workDir = mkdtempSync(join(tmpdir(), "woof-package-smoke-"));
const npmCache = join(workDir, "npm-cache");

try {
  const packed = run(
    "npm",
    ["pack", "--json", "--pack-destination", workDir, "--cache", npmCache],
    repoRoot,
  );
  const [packInfo] = JSON.parse(packed) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  const shipped = packInfo!.files.map((file) => file.path);
  // The Herdr manifest builds from a checkout (lockfile, sources, tsconfig), so
  // shipping it without those inputs would advertise a build that cannot run.
  // The Bash launcher is checkout-only; the installed bin is the Node entry.
  const strays = shipped.filter((path) => path === "herdr-plugin.toml" || path.startsWith("bin/"));
  if (strays.length > 0) {
    throw new Error(`tarball ships checkout-only files: ${strays.join(", ")}`);
  }
  const tarball = join(workDir, packInfo!.filename);
  const consumer = join(workDir, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "woof-package-smoke", private: true, version: "0.0.0", type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--cache",
      npmCache,
      tarball,
    ],
    consumer,
  );

  const installedBin = join(consumer, "node_modules", ".bin", "woof");
  const importCheck =
    'const entry = await import("herdr-woof"); if (entry.SDK_FOUNDATION !== true) process.exit(1);';
  run("node", ["--input-type=module", "--eval", importCheck], consumer);
  run(installedBin, ["--help"], consumer);
  const version = run(installedBin, ["--version"], consumer).trim();
  if (version !== pkg.version) {
    throw new Error(`installed woof --version printed ${version}, expected ${pkg.version}`);
  }
  run(installedBin, ["doctor"], consumer);

  console.log("installed package entry point ok");
  console.log("installed woof --help ok");
  console.log("installed woof --version ok");
  console.log("installed woof doctor ok");
} finally {
  rmSync(workDir, { force: true, recursive: true });
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = result.error?.message ?? `${result.stdout}\n${result.stderr}`;
    throw new Error(`${command} ${args.join(" ")} failed:\n${detail}`);
  }
  return result.stdout;
}
