import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/process.js";

// GitHub Actions workflows (phase 7 D5, D12; Changesets release flow), checked as the files that run:
// every action pinned to a commit, least privilege, and a release job that publishes with OIDC and no
// npm token.
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
          /^\s*-?\s*uses: [\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
        );
      }
    }
  });

  it("grant only contents: read at the top level of CI, and nothing at the top level of release", () => {
    expect(workflow("ci.yml")).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
    expect(workflow("release.yml")).toMatch(/^permissions: \{\}\n/m);
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

  it("release on master with Changesets: select-mode, version PR, gate, pack, then publish with trusted publishing and no npm token", () => {
    const release = workflow("release.yml");
    expect(release).toMatch(/^on:\n {2}push:\n {4}branches: \[master\]\n/m);
    expect(release).not.toContain("tags:");
    expect(release).not.toContain("NPM_TOKEN");
    expect(release).not.toContain("NODE_AUTH_TOKEN");
    expect(release).toMatch(
      /^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false\n/m,
    );
    // id-token is granted to the publish job only.
    expect(release.match(/id-token: write/g)).toHaveLength(1);

    const selectMode = job(release, "select-mode");
    expect(selectMode).toMatch(/permissions:\n {6}contents: read\n/);
    expect(selectMode).toContain("persist-credentials: false");
    expect(selectMode).toContain("uses: changesets/action/select-mode@");
    expect(selectMode).toContain("mode: ${{ steps.select-mode.outputs.mode }}");

    const version = job(release, "version");
    expect(version).toContain("if: needs.select-mode.outputs.mode == 'version'");
    expect(version).toMatch(/permissions:\n {6}contents: write\n {6}pull-requests: write\n/);
    expect(version).toContain("uses: changesets/action/version@");
    expect(version).toContain("script: bun run version");
    expect(version).toContain('pr-title: "chore: version packages"');
    // The only secret anywhere is the optional token for the Version PR.
    expect(release.replaceAll("secrets.CHANGESETS_TOKEN", "")).not.toContain("secrets.");

    const gate = job(release, "gate");
    expect(gate).toContain("if: needs.select-mode.outputs.mode == 'publish'");
    expect(gate).toMatch(/permissions:\n {6}contents: read\n(?! {6})/);
    expect(gate).toContain("run: bun run verify");
    expect(gate).toContain(
      "run: bun run release:preflight --only versions,changelog,private-strings,pack",
    );

    const pack = job(release, "pack");
    expect(pack).toContain("needs: [select-mode, gate]");
    expect(pack).toContain("run: bun run build");
    expect(pack).toContain("uses: changesets/action/pack@");
    expect(pack).not.toContain("id-token");

    const publish = job(release, "publish");
    expect(publish).toContain("needs: pack");
    expect(publish).toContain("environment: npm");
    expect(publish).toContain("runs-on: ubuntu-latest");
    expect(publish).toMatch(/permissions:\n {6}contents: write\n {6}id-token: write\n/);
    expect(publish).not.toContain("secrets.");
    expect(publish).toContain("persist-credentials: false");
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
    expect(publish).toContain("uses: changesets/action/publish@");
    expect(publish).toContain(
      "pack-dir-artifact-id: ${{ needs.pack.outputs.pack-dir-artifact-id }}",
    );
    expect(publish).toContain("create-github-releases: true");
    expect(publish.indexOf("npm install -g npm@")).toBeLessThan(
      publish.indexOf("changesets/action/publish@"),
    );
  });

  it("fail a PR that changes src/ without a changeset, except the Version PR", () => {
    const changelog = job(workflow("ci.yml"), "changelog");
    expect(changelog).toContain("name: changelog");
    expect(changelog).toContain('if [ "$HEAD_REF" = "changeset-release/master" ]; then');
    expect(changelog).toContain(
      "::error::this PR changes src/ but adds no changeset; run bun run changeset",
    );
  });
});
