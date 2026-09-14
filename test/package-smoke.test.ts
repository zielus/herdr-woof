import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

it("installs and runs the packed package in an isolated consumer", () => {
  const result = spawnSync("bun", ["run", "smoke:package"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("installed package entry point ok");
  expect(result.stdout).toContain("installed woof --help ok");
  expect(result.stdout).toContain("installed woof --version ok");
  expect(result.stdout).toContain("installed woof doctor ok");
});
