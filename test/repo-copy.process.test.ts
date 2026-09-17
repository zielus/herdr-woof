import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyRepository } from "./helpers/repo-copy.js";

// The repository-copy helper as real git processes. A detached `git maintenance run --auto` spawned
// by the copy's commit outlives copyRepository() and races the test's cleanup of the copy.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("copyRepository", () => {
  it("commits the copy without spawning git's detached auto-maintenance", () => {
    const traceDir = mkdtempSync(join(tmpdir(), "woof-repo-copy-trace-"));
    dirs.push(traceDir);
    const trace = join(traceDir, "git.trace");
    const previous = process.env["GIT_TRACE"];
    process.env["GIT_TRACE"] = trace;
    try {
      dirs.push(copyRepository());
    } finally {
      if (previous === undefined) delete process.env["GIT_TRACE"];
      else process.env["GIT_TRACE"] = previous;
    }
    const text = readFileSync(trace, "utf8");
    // The trace really covers the commit, so the absence below is not vacuous.
    expect(text).toContain("git commit -q -m copy");
    expect(text).not.toContain("maintenance run --auto");
  }, 60_000);
});
