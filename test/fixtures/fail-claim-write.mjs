// Preload for claim-failure tests (PR #6, src/host/claim.ts:68), loaded with
// NODE_OPTIONS=--import=<this file>. Only in a `woof run host` process, every
// write to a descriptor opened exclusively on host.json fails with ENOSPC, so
// the claim is created but its single write never lands. Every other process
// (the launcher, the fake Herdr) is untouched.
import { createRequire, syncBuiltinESMExports } from "node:module";

if (process.argv[2] === "run" && process.argv[3] === "host") {
  const fs = createRequire(import.meta.url)("node:fs");
  const claimFds = new Set();
  const openSync = fs.openSync;
  fs.openSync = (path, flags, ...rest) => {
    const fd = openSync(path, flags, ...rest);
    if (
      String(path).endsWith("/host.json") &&
      typeof flags === "number" &&
      (flags & fs.constants.O_EXCL) !== 0
    )
      claimFds.add(fd);
    return fd;
  };
  // Descriptor numbers are reused: once the claim's descriptor is closed, a later file is no claim.
  const closeSync = fs.closeSync;
  fs.closeSync = (fd) => {
    claimFds.delete(fd);
    return closeSync(fd);
  };
  const writeSync = fs.writeSync;
  fs.writeSync = (fd, ...rest) => {
    if (claimFds.has(fd)) {
      const error = new Error("ENOSPC: no space left on device, write");
      error.code = "ENOSPC";
      throw error;
    }
    return writeSync(fd, ...rest);
  };
  syncBuiltinESMExports();
}
