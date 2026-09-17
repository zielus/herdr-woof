#!/usr/bin/env bun
/**
 * Release preflight (phase 7 D2): the checks a release must pass, in order, with
 * one machine-readable summary. Human progress goes to stderr; the last stdout
 * line is `{"kind":"woof.release.preflight","schemaVersion":1,"ok",...}`.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";

import { repoRoot } from "../lib/metadata.js";
import { releaseSectionProblem } from "./lib/changelog.js";
import {
  classifyLink,
  isAbsoluteRef,
  readmeImageRefs,
  type LinkStatus,
  type Visibility,
} from "./lib/links.js";
import { PRIVATE_STRING_EXCLUDES, PRIVATE_STRING_PATTERNS } from "./lib/patterns.js";
import { checkVersions } from "./lib/versions.js";

const USAGE = `Usage: bun run release:preflight [--strict] [--only <ids> | --skip <ids>]
                                 [--tag <vX.Y.Z>] [--visibility public|private|auto]

Runs the release checks in order: versions, changelog, private-strings, secrets,
links, format, verify, pack. Each reports pass, warn, skip or fail.

  --strict      turn every warn and skip (including --skip) into fail
  --only <ids>  run only these comma-separated checks
  --skip <ids>  do not run these checks; they are listed as skip
  --tag <tag>   versions also requires the tag to be v + the package version
  --visibility  the repository visibility for links (default auto: gh repo view;
                unknown when gh is missing or fails)

Progress goes to stderr; the last stdout line is one JSON summary.
Exits 0 when no check failed, 1 when any check failed, 2 on a usage error.`;

export const CHECK_IDS = [
  "versions",
  "changelog",
  "private-strings",
  "secrets",
  "links",
  "format",
  "verify",
  "pack",
] as const;
type CheckId = (typeof CHECK_IDS)[number];
type Status = "pass" | "warn" | "skip" | "fail";

interface CheckResult {
  id: CheckId;
  status: Status;
  message: string;
  details: string[];
}

/** What `npm pack` may ship, and what it must. */
const PACK_ALLOWED = [
  /^LICENSE$/,
  /^README\.md$/,
  /^package\.json$/,
  /^dist\//,
  /^plugin\/claude\//,
];
const PACK_REQUIRED = [
  "dist/index.js",
  "dist/cli.js",
  "dist/testing.js",
  "plugin/claude/.claude-plugin/plugin.json",
  "plugin/claude/commands/run.md",
  "plugin/claude/skills/woof/SKILL.md",
];
const LINK_TIMEOUT_MS = 10_000;
const MAX_DETAILS = 50;

function usageError(message: string): never {
  console.error(`release:preflight: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function ids(value: string | undefined, flag: string): CheckId[] | undefined {
  if (value === undefined) return undefined;
  const list = value.split(",").map((item) => item.trim());
  for (const item of list) {
    if (!(CHECK_IDS as readonly string[]).includes(item))
      usageError(`${flag}: unknown check ${JSON.stringify(item)}; checks: ${CHECK_IDS.join(", ")}`);
  }
  return list as CheckId[];
}

function result(id: CheckId, status: Status, message: string, details: string[] = []): CheckResult {
  return { id, status, message, details: details.slice(0, MAX_DETAILS) };
}

const ANSI_COLOR = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "g");

/** Non-blank lines, without terminal color codes (gitleaks colors its log even when piped). */
function lines(text: string): string[] {
  return text
    .replaceAll(ANSI_COLOR, "")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function onPath(command: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

function versionsCheck(tag: string | undefined): CheckResult {
  const report = checkVersions(repoRoot, tag !== undefined ? { tag } : {});
  return report.problems.length === 0
    ? result(
        "versions",
        "pass",
        `${report.version} in package.json, herdr-plugin.toml and plugin.json${tag !== undefined ? `; tag ${tag}` : ""}`,
      )
    : result("versions", "fail", report.problems[0] as string, report.problems);
}

function changelogCheck(version: string | null): CheckResult {
  if (version === null) return result("changelog", "fail", "package.json has no version");
  const text = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const problem = releaseSectionProblem(text, version);
  if (problem !== undefined) return result("changelog", "fail", problem);
  return result("changelog", "pass", `CHANGELOG.md has a non-empty section for ${version}`);
}

function privateStringsCheck(): CheckResult {
  const grep = spawnSync(
    "git",
    [
      "grep",
      "-n",
      "-I",
      "-E",
      ...PRIVATE_STRING_PATTERNS.flatMap((pattern) => ["-e", pattern]),
      "--",
      ".",
      ...PRIVATE_STRING_EXCLUDES.map((path) => `:(exclude)${path}`),
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (grep.status === 1)
    return result("private-strings", "pass", "no tracked file matches a private-string pattern");
  if (grep.status === 0) {
    const hits = lines(grep.stdout).map((line) => line.split(":").slice(0, 2).join(":"));
    return result(
      "private-strings",
      "fail",
      `${hits.length} tracked line(s) match a private-string pattern`,
      hits,
    );
  }
  return result(
    "private-strings",
    "fail",
    `git grep failed: ${(grep.stderr || grep.error?.message || `exit ${grep.status}`).trim()}`,
  );
}

function secretsCheck(): CheckResult {
  const gitleaks = onPath("gitleaks");
  if (gitleaks === undefined) {
    const bar = "=".repeat(64);
    console.error(`preflight: ${bar}`);
    console.error("preflight: gitleaks is not installed: git history was NOT scanned for secrets");
    console.error(`preflight: ${bar}`);
    return result("secrets", "skip", "gitleaks is not installed; history NOT scanned");
  }
  const scan = spawnSync(gitleaks, ["git", "--no-banner", "--redact", "."], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = lines(`${scan.stdout ?? ""}\n${scan.stderr ?? ""}`);
  if (scan.status === 0)
    return result(
      "secrets",
      "pass",
      "gitleaks found no leaks in the git history",
      output.slice(-3),
    );
  return result(
    "secrets",
    "fail",
    `gitleaks exited ${scan.status ?? scan.error?.message ?? "abnormally"}`,
    output.slice(-20),
  );
}

function repositoryVisibility(flag: string): Visibility {
  if (flag === "public" || flag === "private") return flag;
  const gh = spawnSync("gh", ["repo", "view", "--json", "visibility"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (gh.status !== 0) return "unknown";
  try {
    const value = (JSON.parse(gh.stdout) as { visibility?: unknown }).visibility;
    if (value === "PUBLIC") return "public";
    return value === "PRIVATE" || value === "INTERNAL" ? "private" : "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchStatus(url: string, method: "HEAD" | "GET"): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

async function linksCheck(visibilityFlag: string): Promise<CheckResult> {
  const readme = join(repoRoot, "README.md");
  if (!existsSync(readme)) return result("links", "fail", "README.md does not exist");
  const refs = [...new Set(readmeImageRefs(readFileSync(readme, "utf8")))];
  const visibility = refs.some(isAbsoluteRef) ? repositoryVisibility(visibilityFlag) : "unknown";
  // Every reference is checked independently, so the requests run concurrently.
  const checked = await Promise.all(
    refs.map(async (ref): Promise<{ verdict: LinkStatus; detail?: string }> => {
      if (!isAbsoluteRef(ref)) {
        const path = ref.replace(/[?#].*$/, "").replace(/^\.\//, "");
        return path !== "" && !path.startsWith("/") && existsSync(join(repoRoot, path))
          ? { verdict: "pass" }
          : { verdict: "fail", detail: `${ref}: fail (no such file in the repository)` };
      }
      const head = await fetchStatus(ref, "HEAD");
      const status =
        head === null || head >= 400 ? ((await fetchStatus(ref, "GET")) ?? head) : head;
      const verdict = classifyLink(ref, status, visibility);
      if (verdict === "pass") return { verdict };
      const answer = status === null ? "no response" : `HTTP ${status}`;
      return {
        verdict,
        detail: `${ref}: ${verdict} (${answer}${verdict === "warn" ? `; repository visibility ${visibility}` : ""})`,
      };
    }),
  );
  const statuses = checked.map((item) => item.verdict);
  const details = checked.flatMap((item) => (item.detail === undefined ? [] : [item.detail]));
  const failed = statuses.filter((status) => status === "fail").length;
  const warned = statuses.filter((status) => status === "warn").length;
  const summary = `${refs.length} README image reference(s): ${refs.length - failed - warned} pass, ${warned} warn, ${failed} fail (visibility ${visibility})`;
  return result("links", failed > 0 ? "fail" : warned > 0 ? "warn" : "pass", summary, details);
}

function scriptCheck(id: "format" | "verify", script: string): CheckResult {
  console.error(`preflight: ${id}: bun run ${script}`);
  // The child's stdout goes to stderr too: the summary must stay the last stdout line.
  const run = spawnSync("bun", ["run", script], { cwd: repoRoot, stdio: ["ignore", 2, 2] });
  return run.status === 0
    ? result(id, "pass", `bun run ${script} exited 0`)
    : result(
        id,
        "fail",
        `bun run ${script} exited ${run.status ?? run.error?.message ?? "abnormally"}`,
      );
}

function packCheck(): CheckResult {
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (pack.status !== 0)
    return result(
      "pack",
      "fail",
      `npm pack --dry-run exited ${pack.status ?? pack.error?.message}`,
      lines(pack.stderr ?? "").slice(-10),
    );
  let files: string[];
  try {
    const [info] = JSON.parse(pack.stdout) as Array<{ files: Array<{ path: string }> }>;
    files = (info?.files ?? []).map((file) => file.path);
  } catch (error) {
    return result(
      "pack",
      "fail",
      `npm pack --dry-run --json output is not JSON: ${(error as Error).message}`,
    );
  }
  const strays = files.filter((path) => !PACK_ALLOWED.some((pattern) => pattern.test(path)));
  const missing = PACK_REQUIRED.filter((path) => !files.includes(path));
  if (strays.length === 0 && missing.length === 0)
    return result(
      "pack",
      "pass",
      `${files.length} file(s), all within LICENSE, README.md, package.json, dist/, plugin/claude/`,
    );
  return result(
    "pack",
    "fail",
    `tarball has ${strays.length} file(s) outside the allowlist and misses ${missing.length} required file(s)`,
    [...strays.map((path) => `not allowed: ${path}`), ...missing.map((path) => `missing: ${path}`)],
  );
}

const { values } = (() => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        strict: { type: "boolean" },
        only: { type: "string" },
        skip: { type: "string" },
        tag: { type: "string" },
        visibility: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return usageError((error as Error).message);
  }
})();
if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}
const only = ids(values.only, "--only");
const skipped = ids(values.skip, "--skip");
if (only !== undefined && skipped !== undefined) usageError("--only and --skip cannot be combined");
const visibilityFlag = values.visibility ?? "auto";
if (!["public", "private", "auto"].includes(visibilityFlag))
  usageError("--visibility must be public, private or auto");
if (values.tag !== undefined && !/^v\S+$/.test(values.tag))
  usageError("--tag must look like vX.Y.Z");

const version = checkVersions(repoRoot).version;
const results: CheckResult[] = [];
for (const id of CHECK_IDS) {
  if (only !== undefined && !only.includes(id)) continue;
  let checked: CheckResult;
  if (skipped?.includes(id) === true) {
    checked = result(id, "skip", "skipped by --skip");
  } else {
    switch (id) {
      case "versions":
        checked = versionsCheck(values.tag);
        break;
      case "changelog":
        checked = changelogCheck(version);
        break;
      case "private-strings":
        checked = privateStringsCheck();
        break;
      case "secrets":
        checked = secretsCheck();
        break;
      case "links":
        // The checks run one at a time, in order: only links is asynchronous.
        // oxlint-disable-next-line no-await-in-loop
        checked = await linksCheck(visibilityFlag);
        break;
      case "format":
        checked = scriptCheck("format", "format:check");
        break;
      case "verify":
        checked = scriptCheck("verify", "verify");
        break;
      case "pack":
        checked = packCheck();
        break;
    }
  }
  if (values.strict === true && (checked.status === "warn" || checked.status === "skip")) {
    checked = {
      ...checked,
      status: "fail",
      message: `${checked.message} (${checked.status} is a fail under --strict)`,
    };
  }
  console.error(`preflight: ${checked.id} ${checked.status}: ${checked.message}`);
  for (const detail of checked.details) console.error(`preflight:   ${detail}`);
  results.push(checked);
}

const ok = results.every((checked) => checked.status !== "fail");
console.log(
  JSON.stringify({
    kind: "woof.release.preflight",
    schemaVersion: 1,
    ok,
    version,
    checks: results,
  }),
);
process.exit(ok ? 0 : 1);
