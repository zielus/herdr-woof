#!/usr/bin/env bun
/**
 * Version consistency gate: package.json is the single source of truth, its
 * version has to be semver, and the changelog has to carry a section for it
 * (or still be unreleased at 0.0.0).
 */
import { readFile } from "node:fs/promises";

import { changelogPath, readPackageVersion, repoRoot, SEMVER } from "./lib/metadata.ts";

const version = await readPackageVersion();
const problems: string[] = [];

if (!SEMVER.test(version)) problems.push(`package.json version is not semver: ${version}`);

const changelog = await readFile(changelogPath, "utf8");
if (version !== "0.0.0" && !changelog.includes(`## [${version}]`)) {
  problems.push(`CHANGELOG.md has no \`## [${version}]\` section`);
}

if (problems.length > 0) {
  console.error(`version check failed in ${repoRoot}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`version ok: ${version} (package.json, CHANGELOG.md)`);
