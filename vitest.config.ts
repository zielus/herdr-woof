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
      include: ["src/**"],
      // No thresholds yet — this is scaffolding, not the orchestration
      // engine. Set real thresholds once there is real behavior to cover.
    },
  },
});
