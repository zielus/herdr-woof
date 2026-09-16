#!/usr/bin/env bun
/**
 * Release notes (phase 7 D4): the body of a CHANGELOG.md release section, for
 * `gh release create vX.Y.Z --notes-file`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { SEMVER, repoRoot } from "../lib/metadata.js";
import { releaseSectionProblem, changelogSection } from "./lib/changelog.js";
import { checkVersions } from "./lib/versions.js";

const USAGE = `Usage: bun run release:notes [x.y.z] [--out <file>]

Prints the body of "## [x.y.z] - <date>" from CHANGELOG.md, without its heading
(default version: package.json). --out writes it to <file> instead.
Exits 2 when the section is missing, undated or empty, or on a usage error.`;

function refuse(message: string): never {
  console.error(`release:notes: ${message}`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: { out: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
} catch (error) {
  refuse(`${(error as Error).message}\n\n${USAGE}`);
}
const { values, positionals } = parsed;
if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals.length > 1) refuse(`expected at most one version\n\n${USAGE}`);
const version = positionals[0] ?? checkVersions(repoRoot).version;
if (version === null || !SEMVER.test(version))
  refuse(`${JSON.stringify(version)} is not a semver version\n\n${USAGE}`);

const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
const problem = releaseSectionProblem(changelog, version);
if (problem !== undefined) refuse(problem);
const body = `${(changelogSection(changelog, version) as { body: string }).body}\n`;
if (values.out !== undefined) writeFileSync(values.out, body);
else process.stdout.write(body);
