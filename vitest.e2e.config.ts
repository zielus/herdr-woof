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
