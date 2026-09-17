import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GIT_ENV, copyRepository, git } from "./helpers/repo-copy.js";

// `bun run release:preflight` (phase 7 D2, T7) as real `bun scripts/release/preflight.ts` processes
// in a throwaway copy of the repository. No check here reaches the network except a local server,
// and the real `bun run verify` is never recursed into: the copy's scripts are replaced.
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

interface Preflight {
  status: number | null;
  stdout: string;
  stderr: string;
  summary: Json | undefined;
}

function onPath(command: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return join(dir, command);
    } catch {
      // Not here.
    }
  }
  return undefined;
}

const bun = onPath("bun") as string;

function copy(): string {
  const root = copyRepository();
  dirs.push(root);
  return root;
}

/** Runs preflight in `root` without blocking this process (a local HTTP server may need to answer). */
function preflight(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<Preflight> {
  const home = mkdtempSync(join(tmpdir(), "woof-release-home-"));
  dirs.push(home);
  return new Promise((resolve, reject) => {
    const child = spawn(bun, [join(root, "scripts", "release", "preflight.ts"), ...args], {
      cwd: root,
      env: { ...process.env, ...GIT_ENV, HOME: home, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => {
      let summary: Json | undefined;
      try {
        summary = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Json;
      } catch {
        summary = undefined;
      }
      resolve({ status, stdout, stderr, summary });
    });
  });
}

function check(run: Preflight, id: string): Json | undefined {
  return (run.summary?.["checks"] as Json[] | undefined)?.find((item) => item["id"] === id);
}

/** Sets package.json's version and puts `section` at the top of CHANGELOG.md, below the title. */
function withRelease(root: string, version: string, section: string): void {
  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Json;
  pkg["version"] = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const path = join(root, "CHANGELOG.md");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("# Changelog\n\n", `# Changelog\n\n${section}\n`),
  );
}

function setScripts(root: string, scripts: Record<string, string>): void {
  const path = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")) as Json;
  pkg["scripts"] = { ...pkg["scripts"], ...scripts };
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

describe("release:preflight", () => {
  it("(a) passes a clean copy and prints one parseable summary as the last stdout line", async () => {
    const root = copy();
    const run = await preflight(root, ["--only", "versions,changelog,private-strings,pack"]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Json)[
      "version"
    ];
    expect(run.summary).toEqual({
      kind: "woof.release.preflight",
      schemaVersion: 1,
      ok: true,
      version,
      checks: [
        expect.objectContaining({ id: "versions", status: "pass" }),
        expect.objectContaining({ id: "changelog", status: "pass" }),
        expect.objectContaining({ id: "private-strings", status: "pass" }),
        expect.objectContaining({ id: "pack", status: "pass" }),
      ],
    });
    // Progress is on stderr: stdout is the summary alone.
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    expect(run.stderr).toContain("preflight: versions pass");
  }, 120_000);

  it("(b) fails versions when herdr-plugin.toml disagrees, and (j) check:version fails on a plugin.json drift", async () => {
    const root = copy();
    const toml = join(root, "herdr-plugin.toml");
    writeFileSync(
      toml,
      readFileSync(toml, "utf8").replace(/^version = ".*"$/m, 'version = "9.9.9"'),
    );
    const run = await preflight(root, ["--only", "versions"]);
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.summary).toMatchObject({ ok: false });
    expect(check(run, "versions")).toMatchObject({
      status: "fail",
      details: [expect.stringContaining("herdr-plugin.toml version 9.9.9 differs")],
    });

    const clean = copy();
    const pluginJson = join(clean, "plugin", "claude", ".claude-plugin", "plugin.json");
    writeFileSync(
      pluginJson,
      readFileSync(pluginJson, "utf8").replace(/"version": "[^"]*"/, '"version": "9.9.9"'),
    );
    const checked = spawnSync(bun, [join(clean, "scripts", "check-version.ts")], {
      cwd: clean,
      encoding: "utf8",
    });
    expect(checked.status, checked.stdout + checked.stderr).toBe(1);
    expect(checked.stderr).toContain(
      "plugin/claude/.claude-plugin/plugin.json version 9.9.9 differs",
    );
  }, 120_000);

  it("(c) fails versions when --tag is not v + the package version", async () => {
    const root = copy();
    const run = await preflight(root, ["--only", "versions", "--tag", "v9.9.9"]);
    expect(run.status).toBe(1);
    expect(check(run, "versions")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("tag v9.9.9 is not v"),
    });
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Json)[
      "version"
    ];
    const matching = await preflight(root, ["--only", "versions", "--tag", `v${version}`]);
    expect(matching.status, matching.stderr).toBe(0);
  }, 120_000);

  it("(d) fails private-strings on a tracked home path and names the file and line", async () => {
    const root = copy();
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "leak.md"), "first line\nsee /Users/someone/project\n");
    git(root, "add", "notes/leak.md");
    const run = await preflight(root, ["--only", "private-strings"]);
    expect(run.status).toBe(1);
    expect(check(run, "private-strings")).toMatchObject({
      status: "fail",
      details: ["notes/leak.md:2"],
    });
    // An untracked file is not the release's concern.
    git(root, "rm", "-q", "--cached", "notes/leak.md");
    const untracked = await preflight(root, ["--only", "private-strings"]);
    expect(check(untracked, "private-strings")?.["details"]).not.toContain("notes/leak.md:2");
  }, 120_000);

  it("(e) skips secrets loudly without gitleaks, fails it under --strict, and fails a gitleaks that finds a leak", async () => {
    const root = copy();
    const bin = join(root, "..", `${root.split("/").at(-1)}-bin`);
    mkdirSync(bin);
    dirs.push(bin);
    symlinkSync(bun, join(bin, "bun"));
    for (const dir of ["/usr/bin", "/bin"])
      expect(existsSync(join(dir, "gitleaks")), dir).toBe(false);
    const path = `${bin}:/usr/bin:/bin`;

    const skipped = await preflight(root, ["--only", "secrets"], { PATH: path });
    expect(skipped.status, skipped.stdout + skipped.stderr).toBe(0);
    expect(check(skipped, "secrets")).toMatchObject({ status: "skip" });
    expect(skipped.stderr).toContain("git history was NOT scanned for secrets");

    const strict = await preflight(root, ["--only", "secrets", "--strict"], { PATH: path });
    expect(strict.status).toBe(1);
    expect(check(strict, "secrets")).toMatchObject({ status: "fail" });

    writeFileSync(join(bin, "gitleaks"), '#!/bin/sh\necho "leaks found: 1" >&2\nexit 1\n', {
      mode: 0o755,
    });
    const leaked = await preflight(root, ["--only", "secrets"], { PATH: path });
    expect(leaked.status).toBe(1);
    expect(check(leaked, "secrets")).toMatchObject({
      status: "fail",
      details: expect.arrayContaining(["leaks found: 1"]),
    });

    writeFileSync(join(bin, "gitleaks"), '#!/bin/sh\necho "no leaks found" >&2\nexit 0\n', {
      mode: 0o755,
    });
    const clean = await preflight(root, ["--only", "secrets"], { PATH: path });
    expect(clean.status).toBe(0);
    expect(check(clean, "secrets")).toMatchObject({ status: "pass" });
  }, 120_000);

  it("(f) checks README images: a 404 and a missing relative file fail; this repository's own 404 warns only while private", async () => {
    const server = createServer((request, response) => {
      response.statusCode = request.url === "/ok.svg" ? 200 : 404;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const root = copy();
    writeFileSync(
      join(root, "README.md"),
      [
        "<picture>",
        '  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/woof.svg">',
        `  <img alt="ok" src="${base}/ok.svg" width="160">`,
        "</picture>",
        "",
        `[![gone](${base}/missing.svg)](https://example.invalid)`,
        "![nope](assets/nope.svg)",
        "",
      ].join("\n"),
    );
    const run = await preflight(root, ["--only", "links", "--visibility", "public"]);
    expect(run.status, run.stdout + run.stderr).toBe(1);
    const links = check(run, "links") as Json;
    expect(links["status"]).toBe("fail");
    expect(links["details"]).toEqual([
      `${base}/missing.svg: fail (HTTP 404)`,
      "assets/nope.svg: fail (no such file in the repository)",
    ]);
    expect(links["message"]).toContain("4 README image reference(s): 2 pass, 0 warn, 2 fail");

    // The GitHub-host rule cannot reach a local server: the pure classifier, in a child process.
    const classified = spawnSync(
      bun,
      [
        "-e",
        `const { classifyLink } = await import(${JSON.stringify(join(root, "scripts", "release", "lib", "links.ts"))});
const badge = "https://github.com/zielus/herdr-woof/actions/workflows/ci.yml/badge.svg";
const raw = "https://raw.githubusercontent.com/zielus/herdr-woof/master/assets/brand/woof.svg";
console.log(JSON.stringify([
  classifyLink(raw, 404, "private"), classifyLink(raw, 404, "unknown"), classifyLink(raw, 404, "public"),
  classifyLink(badge, null, "private"), classifyLink(badge, 200, "public"),
  classifyLink("https://img.shields.io/x", 404, "private"), classifyLink("https://github.com/other/repo/x", 404, "private"),
  classifyLink("https://img.shields.io/x", 302, "public"), classifyLink("not a url", 200, "public"), classifyLink("ftp://example.com/x", 200, "public"),
]));`,
      ],
      { encoding: "utf8" },
    );
    expect(classified.status, classified.stderr).toBe(0);
    expect(JSON.parse(classified.stdout)).toEqual([
      "warn",
      "warn",
      "fail",
      "warn",
      "pass",
      "fail",
      "fail",
      "pass",
      "fail",
      "fail",
    ]);
  }, 120_000);

  it("(g) fails pack on a tarball file outside the allowlist or a missing required file", async () => {
    const root = copy();
    const path = join(root, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8")) as Json;
    pkg["files"] = [...pkg["files"], "scripts/"];
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    const stray = await preflight(root, ["--only", "pack"]);
    expect(stray.status, stray.stdout + stray.stderr).toBe(1);
    expect(check(stray, "pack")?.["details"]).toContain("not allowed: scripts/check-version.ts");

    const other = copy();
    rmSync(join(other, "dist", "testing.js"));
    const missing = await preflight(other, ["--only", "pack"]);
    expect(missing.status).toBe(1);
    expect(check(missing, "pack")).toMatchObject({
      status: "fail",
      details: ["missing: dist/testing.js"],
    });
  }, 120_000);

  it("(h) runs format and verify as the repository's scripts and fails on a non-zero exit", async () => {
    const root = copy();
    setScripts(root, { "format:check": 'node -e ""', verify: 'node -e "process.exit(1)"' });
    const run = await preflight(root, ["--only", "format,verify"]);
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.summary?.["checks"]).toEqual([
      expect.objectContaining({ id: "format", status: "pass" }),
      expect.objectContaining({ id: "verify", status: "fail", message: "bun run verify exited 1" }),
    ]);
    setScripts(root, { verify: "node -e \"console.log('verified')\"" });
    const passed = await preflight(root, ["--only", "format,verify"]);
    expect(passed.status).toBe(0);
    // The scripts' own stdout never lands after the summary.
    expect(passed.stdout.trim().split("\n")).toHaveLength(1);
    expect(passed.stderr).toContain("verified");
  }, 120_000);

  it("(i) refuses unknown check ids and bad flags with exit 2, and lists an operator skip as skip", async () => {
    const root = copy();
    for (const args of [
      ["--only", "versions,nosuch"],
      ["--skip", "nosuch"],
      ["--only", "versions", "--skip", "pack"],
      ["--visibility", "secret"],
      ["--tag", "1.0.0"],
      ["--bogus"],
    ]) {
      const run = await preflight(root, args);
      expect(run.status, JSON.stringify(args)).toBe(2);
      expect(run.stderr, JSON.stringify(args)).toContain("Usage: bun run release:preflight");
      expect(run.stdout, JSON.stringify(args)).toBe("");
    }
    setScripts(root, { "format:check": 'node -e ""', verify: 'node -e ""' });
    const skipped = await preflight(root, [
      "--skip",
      "versions,changelog,private-strings,secrets,links,pack",
    ]);
    expect(skipped.status, skipped.stdout + skipped.stderr).toBe(0);
    expect(
      ((skipped.summary as Json)["checks"] as Json[]).map((item) => [item["id"], item["status"]]),
    ).toEqual([
      ["versions", "skip"],
      ["changelog", "skip"],
      ["private-strings", "skip"],
      ["secrets", "skip"],
      ["links", "skip"],
      ["format", "pass"],
      ["verify", "pass"],
      ["pack", "skip"],
    ]);
    expect(check(skipped, "pack")).toMatchObject({ message: "skipped by --skip" });
  }, 120_000);

  it("(k) changelog accepts a Changesets `## x.y.z` and a dated `## [x.y.z] - date` section, ignores a leftover [Unreleased], and fails a missing, empty or undated one", async () => {
    const cases: Array<[string, string, string, Json]> = [
      ["changesets", "0.1.3", "## 0.1.3\n\n### Patch Changes\n\n- A fix.\n", { status: "pass" }],
      ["legacy", "0.1.3", "## [0.1.3] - 2026-09-18\n\n### Fixed\n\n- A fix.\n", { status: "pass" }],
      [
        "leftover Unreleased",
        "0.1.3",
        "## [Unreleased]\n\n### Added\n\n- Not released yet.\n\n## 0.1.3\n\n### Patch Changes\n\n- A fix.\n",
        { status: "pass" },
      ],
      [
        "missing",
        "0.1.3",
        "",
        { status: "fail", message: "CHANGELOG.md has no `## 0.1.3` section" },
      ],
      [
        "empty",
        "0.1.3",
        "## 0.1.3\n",
        { status: "fail", message: "CHANGELOG.md `## 0.1.3` has no entries" },
      ],
      [
        "undated legacy",
        "0.1.3",
        "## [0.1.3]\n\n### Fixed\n\n- A fix.\n",
        {
          status: "fail",
          message: expect.stringContaining("is not dated as `## [0.1.3] - YYYY-MM-DD`"),
        },
      ],
    ];
    const root = copy();
    const original = ["package.json", "CHANGELOG.md"].map(
      (rel) => [rel, readFileSync(join(root, rel), "utf8")] as const,
    );
    for (const [name, version, section, expected] of cases) {
      for (const [rel, text] of original) writeFileSync(join(root, rel), text);
      withRelease(root, version, section);
      // oxlint-disable-next-line no-await-in-loop
      const run = await preflight(root, ["--only", "changelog"]);
      expect(check(run, "changelog"), name).toMatchObject(expected);
      expect(run.status, name).toBe(expected["status"] === "pass" ? 0 : 1);
    }
  }, 120_000);
});
