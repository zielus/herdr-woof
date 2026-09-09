import { defineConfig } from "vitest/config";

/**
 * The integration suites: each spawns a process, so they are slower and more
 * environment-bound than the unit suite. They run apart from it, capped at two
 * workers so a laptop stays usable, and once per CI run rather than in every
 * job.
 *
 * The fake-Herdr suites are deliberately NOT here: they bind a unix socket but
 * stay in-process and finish in a second, and keeping them in the unit suite is
 * what makes its coverage report mean anything.
 */
export const E2E_GROUPS = {
  /** The built CLI, spawned as a child process. */
  cli: ["test/repo/cli.test.ts"],
  /** The load seam against a real Node, whose type stripping vite would hide. */
  loader: ["test/loader/native-import.test.ts"],
  /**
   * Effect execution and crash recovery: every file here spawns a real child
   * process, and the kill-window probe SIGKILLs one at each of the three
   * interruption windows (SPEC A10).
   */
  effects: [
    "test/runner/shell.test.ts",
    "test/runner/effects.test.ts",
    "test/runner/supervision.test.ts",
    "test/recovery/kill-window.test.ts",
  ],
  /**
   * The single-server lock, which only two real processes can prove (A9), and
   * park/resume, which needs a real server, a real runner and a real socket
   * (A4, A5).
   */
  server: ["test/server/server-lifecycle.test.ts", "test/server/park-resume.e2e.test.ts"],
  /** The extension's binaries: the hooks and the MCP server, as processes. */
  extension: ["test/extension/binaries.e2e.test.ts"],
} as const;

export const E2E_SUITES = Object.values(E2E_GROUPS).flat();

/**
 * `E2E_GROUP=<name>` runs one group; unset runs them all.
 */
function selectedSuites(): readonly string[] {
  const group = process.env.E2E_GROUP;
  if (group === undefined || group === "") return E2E_SUITES;
  const suites = (E2E_GROUPS as Record<string, readonly string[]>)[group];
  if (suites === undefined) {
    throw new Error(
      `Unknown E2E_GROUP "${group}"; expected one of ${Object.keys(E2E_GROUPS).join(", ")}`,
    );
  }
  return suites;
}

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [...selectedSuites()],
    exclude: ["node_modules/**"],
    // Two workers keep a laptop usable; CI runners have two cores, so one.
    maxWorkers: process.env.CI === undefined ? 2 : 1,
  },
});
