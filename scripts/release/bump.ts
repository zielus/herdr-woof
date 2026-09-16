#!/usr/bin/env bun
/**
 * Release version bump (phase 7 D3). Edits the version text in package.json,
 * herdr-plugin.toml and the Claude Code plugin.json, and dates the [Unreleased]
 * CHANGELOG entries as the new release. Text edits only: no file is
 * re-serialized. Prints the diff; never commits or tags.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { SEMVER, repoRoot } from "../lib/metadata.js";
import { changelogSection } from "./lib/changelog.js";
import { compareSemver } from "./lib/semver.js";
import { VERSION_FILES, checkVersions } from "./lib/versions.js";

const USAGE = `Usage: bun run release:bump <x.y.z> [--date YYYY-MM-DD]

Sets the version in package.json, herdr-plugin.toml and
plugin/claude/.claude-plugin/plugin.json, and turns the [Unreleased] entries of
CHANGELOG.md into "## [x.y.z] - <date>" (default: today, local time), leaving
[Unreleased] empty. Prints git diff --stat and git diff. Never commits or tags.

Refuses (exit 2, nothing changed) when the version is not semver or not greater
than the current one, the working tree is not clean (untracked files count),
CHANGELOG.md already has the section, or [Unreleased] has no entries.
Exits 1 when the edited files fail the version check, 0 otherwise.`;

function refuse(message: string): never {
  console.error(`release:bump: ${message}`);
  process.exit(2);
}

function git(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Replaces exactly one match of `pattern` (whose group 1 precedes the version) in a file's text. */
function replaceVersion(
  rel: string,
  pattern: RegExp,
  version: string,
): { rel: string; text: string } {
  const text = readFileSync(join(repoRoot, rel), "utf8");
  const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1)
    refuse(`${rel}: expected exactly one version line, found ${matches.length}`);
  return { rel, text: text.replace(pattern, `$1${version}$2`) };
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: { date: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
} catch (error) {
  refuse(`${(error as Error).message}\n\n${USAGE}`);
}
const { values, positionals } = parsed;
if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals.length !== 1) refuse(`expected exactly one <x.y.z>\n\n${USAGE}`);
const next = positionals[0] as string;
if (!SEMVER.test(next)) refuse(`${JSON.stringify(next)} is not a semver version`);
const date = values.date ?? localDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) refuse("--date must be YYYY-MM-DD");

const current = checkVersions(repoRoot);
if (current.problems.length > 0 || current.version === null)
  refuse(`the current versions are inconsistent: ${current.problems.join("; ")}`);
if (compareSemver(next, current.version) <= 0)
  refuse(`${next} is not greater than the current version ${current.version}`);

const status = git("status", "--porcelain");
if (status.status !== 0) refuse(`git status failed: ${status.stderr.trim()}`);
if (status.stdout.trim() !== "")
  refuse(
    `the working tree is not clean (commit or remove these first):\n${status.stdout.trimEnd()}`,
  );

const changelogPath = join(repoRoot, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
if (changelogSection(changelog, next) !== undefined)
  refuse(`CHANGELOG.md already has a \`## [${next}]\` section`);
const unreleased = changelogSection(changelog, "Unreleased");
if (unreleased === undefined) refuse("CHANGELOG.md has no `## [Unreleased]` section");
if (unreleased.body === "") refuse("CHANGELOG.md [Unreleased] has no entries to release");

// Every edit is computed before any file is written, so a refusal leaves the tree untouched.
const headingEnd = unreleased.start + "## [Unreleased]".length;
const edits = [
  replaceVersion(VERSION_FILES.package, /^(\s*"version":\s*")[^"]*(",?)$/m, next),
  replaceVersion(VERSION_FILES.herdr, /^(version = ")[^"]*(")$/m, next),
  replaceVersion(VERSION_FILES.claude, /^(\s*"version":\s*")[^"]*(",?)$/m, next),
  {
    rel: "CHANGELOG.md",
    text: `${changelog.slice(0, headingEnd)}\n\n## [${next}] - ${date}${changelog.slice(headingEnd)}`,
  },
];
for (const edit of edits) writeFileSync(join(repoRoot, edit.rel), edit.text);

const after = checkVersions(repoRoot, { changelog: true });
const diffStat = git("diff", "--stat");
const diff = git("diff");
console.log(diffStat.stdout.trimEnd());
console.log("");
console.log(diff.stdout.trimEnd());
if (after.version !== next || after.problems.length > 0) {
  console.error(
    `release:bump: the edited files fail the version check: ${after.problems.join("; ")}`,
  );
  process.exit(1);
}
console.error(
  `release:bump: ${current.version} -> ${next} (${date}); review the diff, then commit.`,
);
