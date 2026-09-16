import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/process.js";

// GitHub Actions workflows (phase 7 D5, D12), checked as the files that run: every action pinned to
// a commit, least privilege, and a release job that publishes with OIDC and no token.
const workflowsDir = join(repoRoot, ".github", "workflows");

function workflow(name: string): string {
  const path = join(workflowsDir, name);
  expect(existsSync(path), path).toBe(true);
  return readFileSync(path, "utf8");
}

/** The lines of one job: from `  <job>:` to the next job key at the same indent. */
function job(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `job ${name}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][\w-]*:\s*$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("GitHub Actions workflows", () => {
  it("pin every action to a 40-hex commit with its version as a comment (F-028)", () => {
    for (const name of ["ci.yml", "release.yml"]) {
      const uses = workflow(name)
        .split("\n")
        .filter((line) => /^\s*-?\s*uses:/.test(line));
      expect(uses.length, name).toBeGreaterThan(0);
      for (const line of uses) {
        expect(line, `${name}: ${line.trim()}`).toMatch(
          /^\s*-?\s*uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        );
      }
    }
  });

  it("grant only contents: read at the top level", () => {
    for (const name of ["ci.yml", "release.yml"]) {
      expect(workflow(name), name).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
    }
  });

  it("test on ubuntu and macOS in CI", () => {
    const ci = workflow("ci.yml");
    expect(job(ci, "test")).toContain("runs-on: ubuntu-latest");
    const macos = job(ci, "test-macos");
    expect(macos).toContain("runs-on: macos-latest");
    expect(macos).toContain('node-version: "22.18.0"');
    expect(macos).toContain("run: bun install --frozen-lockfile");
    expect(macos).toContain("run: bun run test");
  });

  it("release on a v* tag: verify, then publish with trusted publishing and no token (D5)", () => {
    const release = workflow("release.yml");
    expect(release).toMatch(/^on:\n {2}push:\n {4}tags: \["v\*"\]\n/m);
    expect(release).not.toContain("secrets.");
    expect(release).not.toContain("NODE_AUTH_TOKEN");
    expect(release).toMatch(
      /^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false\n/m,
    );

    const verify = job(release, "verify");
    expect(verify).toContain("runs-on: ubuntu-latest");
    expect(verify).toContain(
      'run: bun run release:preflight --only versions,changelog --tag "$GITHUB_REF_NAME"',
    );
    expect(verify).toContain("run: bun run verify");
    expect(verify).not.toContain("id-token");

    const publish = job(release, "publish");
    expect(publish).toContain("needs: verify");
    expect(publish).toContain("environment: npm");
    expect(publish).toContain("runs-on: ubuntu-latest");
    expect(publish).toMatch(/permissions:\n {6}contents: read\n {6}id-token: write\n/);
    expect(publish).toContain("registry-url: https://registry.npmjs.org");
    expect(publish).toContain('node-version: "22.18.0"');
    // npm trusted publishing needs npm >= 11.5.1; the version is exact.
    const npm = /run: npm install -g npm@(\d+)\.(\d+)\.(\d+)\n/.exec(publish);
    expect(npm, "an exact npm install").not.toBeNull();
    const [major, minor, patch] = (npm as RegExpExecArray).slice(1).map(Number) as [
      number,
      number,
      number,
    ];
    expect(major).toBe(11);
    expect(minor > 5 || (minor === 5 && patch >= 1)).toBe(true);
    expect(publish).toContain("run: bun install --frozen-lockfile");
    expect(publish).toContain("run: npm publish --provenance --access public");
    expect(publish.indexOf("npm install -g npm@")).toBeLessThan(publish.indexOf("npm publish"));
  });
});
