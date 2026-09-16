import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "smol-toml";

import { SEMVER } from "../../lib/metadata.js";
import { releaseSectionProblem } from "./changelog.js";

/** The three files that carry the release version, relative to the repository root. */
export const VERSION_FILES = {
  package: "package.json",
  herdr: "herdr-plugin.toml",
  claude: "plugin/claude/.claude-plugin/plugin.json",
} as const;

export interface VersionReport {
  /** package.json's version (the source of truth), or null when it cannot be read. */
  version: string | null;
  problems: string[];
}

function read(root: string, rel: string, pick: (text: string) => unknown): unknown {
  return pick(readFileSync(join(root, rel), "utf8"));
}

/**
 * The manifest versions agree and are semver (D1). With `changelog`, CHANGELOG.md
 * also has a dated, non-empty `## [version]` section (0.0.0 is exempt). With
 * `tag`, the tag is `v` + the version.
 */
export function checkVersions(
  root: string,
  options: { changelog?: boolean; tag?: string } = {},
): VersionReport {
  const problems: string[] = [];
  const versions: Record<string, unknown> = {};
  for (const [key, rel] of Object.entries(VERSION_FILES)) {
    try {
      versions[key] = read(
        root,
        rel,
        (text) =>
          (rel.endsWith(".toml") ? parse(text) : (JSON.parse(text) as Record<string, unknown>))[
            "version"
          ],
      );
    } catch (error) {
      problems.push(`${rel} cannot be read: ${(error as Error).message}`);
    }
  }
  const version = typeof versions["package"] === "string" ? versions["package"] : null;
  for (const [key, rel] of Object.entries(VERSION_FILES)) {
    if (!(key in versions)) continue;
    const value = versions[key];
    if (typeof value !== "string" || !SEMVER.test(value)) {
      problems.push(`${rel} version is not semver: ${JSON.stringify(value)}`);
    } else if (version !== null && value !== version) {
      problems.push(`${rel} version ${value} differs from package.json ${version}`);
    }
  }
  if (options.changelog === true && version !== null && version !== "0.0.0") {
    const problem = releaseSectionProblem(
      readFileSync(join(root, "CHANGELOG.md"), "utf8"),
      version,
    );
    if (problem !== undefined) problems.push(problem);
  }
  if (options.tag !== undefined && options.tag !== `v${version ?? ""}`) {
    problems.push(`tag ${options.tag} is not v${version ?? "<unknown>"} (package.json)`);
  }
  return { version, problems };
}
