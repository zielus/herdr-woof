#!/usr/bin/env bun
/**
 * Version sync for the Changesets release flow. `changeset version` edits only
 * package.json and CHANGELOG.md; this copies package.json's version into
 * herdr-plugin.toml and the Claude Code plugin.json. Text edits only: no file
 * is re-serialized. Idempotent; prints what changed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SEMVER, repoRoot } from "../lib/metadata.js";
import { VERSION_FILES } from "./lib/versions.js";

function fail(message: string): never {
  console.error(`sync-version: ${message}`);
  process.exit(1);
}

/** The text of `rel` with its one version line (group 1 precedes the version, group 3 follows it) set. */
function withVersion(
  rel: string,
  pattern: RegExp,
  version: string,
): { text: string; from: string; changed: boolean } {
  const text = readFileSync(join(repoRoot, rel), "utf8");
  const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1)
    fail(`${rel}: expected exactly one version line, found ${matches.length}`);
  const from = (matches[0] as RegExpMatchArray)[2] as string;
  return { text: text.replace(pattern, `$1${version}$3`), from, changed: from !== version };
}

const version = (
  JSON.parse(readFileSync(join(repoRoot, VERSION_FILES.package), "utf8")) as {
    version?: unknown;
  }
).version;
if (typeof version !== "string" || !SEMVER.test(version))
  fail(`${VERSION_FILES.package} version is not semver: ${JSON.stringify(version)}`);

const targets = [
  { rel: VERSION_FILES.herdr, pattern: /^(version = ")([^"]*)(")$/m },
  { rel: VERSION_FILES.claude, pattern: /^(\s*"version":\s*")([^"]*)(",?)$/m },
];
// Every edit is computed before any file is written, so a failure leaves the tree untouched.
const edits = targets.map(({ rel, pattern }) =>
  Object.assign(withVersion(rel, pattern, version), { rel }),
);
for (const edit of edits) {
  if (edit.changed) {
    writeFileSync(join(repoRoot, edit.rel), edit.text);
    console.log(`${edit.rel}: ${edit.from} -> ${version}`);
  } else {
    console.log(`${edit.rel}: ${version} (no change)`);
  }
}
