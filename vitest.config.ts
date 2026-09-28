import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

const parsedWorkers = Number.parseInt(process.env.WOOF_TEST_WORKERS ?? "", 10);
const maxWorkers = Number.isInteger(parsedWorkers) && parsedWorkers > 0 ? parsedWorkers : 4;

export default defineConfig({
  test: {
    testTimeout: 15_000,
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**"],
    maxWorkers,
    // A run opened inside a test process registers a locator: keep it out of the operator's
    // ~/.woof/index. Child processes get their own HOME from test/helpers/process.ts instead.
    env: { WOOF_INDEX_DIR: join(tmpdir(), `woof-test-index-${process.pid}`) },
  },
});
