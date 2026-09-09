import { defineConfig } from "vitest/config";

import { E2E_SUITES } from "./vitest.e2e.config.js";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // A unit test that needs more than this is an integration test and belongs
    // in vitest.e2e.config.ts.
    testTimeout: 15_000,
    include: ["test/**/*.test.ts"],
    // The suites that drive a real socket run under `bun run test:e2e`.
    exclude: ["node_modules/**", ...E2E_SUITES],
    coverage: {
      provider: "istanbul",
      include: ["src/claude/**", "src/engine/**", "src/herdr/**"],
      exclude: [
        // Re-export, generated and type-only modules contain no behavior to
        // test. Keeping them out also makes branch totals stable across
        // coverage runtimes.
        "src/**/index.ts",
        "src/**/types.ts",
        "src/**/types.generated.ts",
        "src/**/errors.ts",
        // A thin commander wrapper, covered by the spawned-CLI suite in
        // vitest.e2e.config.ts rather than in-process.
        "src/herdr/cli-doctor.ts",
      ],
      // Just under what the suite reaches, so a regression still trips it.
      thresholds: {
        lines: 92,
        functions: 88,
        branches: 78,
        statements: 88,
      },
    },
  },
});
