import { defineConfig } from "vitest/config";

/**
 * The integration suites: each spawns a process, so they are slower and more
 * environment-bound than the unit suite. They run apart from it via
 * `bun run test:e2e`.
 *
 * Empty for now — this is scaffolding, not the orchestration engine. Add a
 * group here (and its test files under test/) as real e2e coverage lands.
 */
export const E2E_GROUPS = {} as const;

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
    // E2E_GROUPS is empty in this scaffold, so `include` above resolves to
    // no files. Without this, vitest's default treats "no test files" as a
    // failure and test:e2e/test:all/verify:full would exit non-zero for a
    // reason that has nothing to do with the code. Drop this once a real
    // e2e group exists.
    passWithNoTests: true,
  },
});
