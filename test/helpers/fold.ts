import { spawnSync } from "node:child_process";

import { expect } from "vitest";

import { loadDist } from "./dist.js";
import { cliPath } from "./process.js";

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

/**
 * Engine-owned projections agree (observability contract): folding every event `woof events`
 * prints for the run reproduces the snapshot `woof run show` derives from its journal, apart
 * from `liveness`, which only a read of `host.json` can know.
 */
export async function expectFoldEqualsSnapshot(
  runDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Json> {
  const run = (args: string[]) => spawnSync("node", [cliPath, ...args], { encoding: "utf8", env });
  const printed = run(["events", runDir]);
  expect(printed.status, printed.stderr).toBe(0);
  const events = printed.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Json)
    .filter((item) => item["kind"] === "woof.run.event");
  const { foldEvents } = await loadDist<{
    foldEvents: (base: null, events: Json[]) => { ok: boolean; projection: { snapshot: Json } };
  }>("observe/events.js");
  const folded = foldEvents(null, events);
  expect(folded.ok, JSON.stringify(folded)).toBe(true);
  const shown = run(["run", "show", runDir]);
  expect(shown.status, shown.stderr).toBe(0);
  const fresh = JSON.parse(shown.stdout) as { snapshot: Json };
  // Liveness is the read-time probe of host.json, never a journal fact: everything else matches.
  const { liveness: _probed, ...recorded } = fresh.snapshot;
  const { liveness: _derived, ...projected } = folded.projection.snapshot;
  expect(projected).toEqual(recorded);
  return fresh.snapshot;
}
