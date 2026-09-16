#!/usr/bin/env bun
/**
 * Version consistency gate: package.json, herdr-plugin.toml and the Claude Code
 * plugin.json carry the same semver version, and the changelog has a dated,
 * non-empty section for it (or it is still unreleased at 0.0.0). The logic is
 * shared with `release:preflight` (scripts/release/lib/versions.ts).
 */
import { repoRoot } from "./lib/metadata.js";
import { checkVersions, VERSION_FILES } from "./release/lib/versions.js";

const report = checkVersions(repoRoot, { changelog: true });

if (report.problems.length > 0) {
  console.error(`version check failed in ${repoRoot}:`);
  for (const problem of report.problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(
  `version ok: ${report.version} (${Object.values(VERSION_FILES).join(", ")}, CHANGELOG.md)`,
);
