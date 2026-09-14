import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const packageJsonPath = join(repoRoot, "package.json");
export const changelogPath = join(repoRoot, "CHANGELOG.md");

export type PackageJson = {
  name: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
};

export async function readPackageJson(root = repoRoot): Promise<PackageJson> {
  return JSON.parse(await readFile(join(root, "package.json"), "utf8")) as PackageJson;
}

export async function readPackageVersion(root = repoRoot): Promise<string> {
  return (await readPackageJson(root)).version;
}

/** Official SemVer 2.0.0 grammar (semver.org) — rejects `01.2.3`, `1.2.3-a.` and friends. */
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
