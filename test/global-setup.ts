import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_TEMP_ROOT_ENV = "WOOF_TEST_TEMP_ROOT";

let ownedRoot: string | undefined;
let previousRoot: string | undefined;

export function setup(): void {
  previousRoot = process.env[TEST_TEMP_ROOT_ENV];
  if (previousRoot !== undefined) return;

  // macOS puts os.tmpdir() ~50 characters deep, which blows the 104-byte unix
  // socket path limit once a fake Herdr socket path is appended to it. /tmp is
  // a symlink to the same place and leaves room.
  const tempRoot = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  ownedRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "woof-tests-")));
  process.env[TEST_TEMP_ROOT_ENV] = ownedRoot;
}

export function teardown(): void {
  if (ownedRoot !== undefined) {
    fs.rmSync(ownedRoot, { force: true, recursive: true });
    ownedRoot = undefined;
  }
  if (previousRoot === undefined) delete process.env[TEST_TEMP_ROOT_ENV];
  else process.env[TEST_TEMP_ROOT_ENV] = previousRoot;
  previousRoot = undefined;
}
