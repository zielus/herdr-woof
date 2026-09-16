// A test-only wrapper around `scribe.mjs` (p5 repair PB-007). The definition it
// re-exports is the shipped one, unchanged; only the workflow name differs,
// because the loader requires a definition's `name` to match its file stem.
//
// WOOF_TEST_SIDE_EFFECT, when set, is appended to once per module evaluation, so
// a test can prove a discovered module's body runs exactly once in the process
// that hosts the run. The hook lives here and not in `scribe.mjs` so the file the
// live fixture ships has zero imports.
import { appendFileSync } from "node:fs";

import scribe from "./scribe.mjs";

const sideEffect = process.env["WOOF_TEST_SIDE_EFFECT"];
if (sideEffect !== undefined) appendFileSync(sideEffect, "evaluated\n");

export default { ...scribe, name: "scribe-once" };
