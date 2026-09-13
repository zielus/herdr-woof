import fs from "node:fs/promises";
import path from "node:path";

import { TEST_TEMP_ROOT_ENV } from "./global-setup.js";

/** A directory inside the suite's owned temp root, removed by the teardown. */
export async function makeTempDir(prefix: string): Promise<string> {
  const root = process.env[TEST_TEMP_ROOT_ENV];
  if (root === undefined) {
    throw new Error(`Test temporary root is not configured: ${TEST_TEMP_ROOT_ENV}`);
  }
  if (path.basename(prefix) !== prefix) {
    throw new Error(`Test temporary directory prefix must be one path segment: ${prefix}`);
  }
  await fs.mkdir(root, { recursive: true });
  return await fs.mkdtemp(path.join(root, `${prefix}-`));
}
