#!/usr/bin/env node
// A stateful stand-in for the acceptance collector's formatter
// (`WOOF_ACCEPTANCE_FORMATTER`). It counts its invocations in a file and fails
// on the call whose number matches, so a test can fail only the *second* pass —
// the one the collector runs after adding `report.format`, whose result used to
// be discarded (PR #7, scripts/acceptance/collect.mjs:189).
//
//   node counting-formatter.mjs <counter-file> <fail-on-call> [--] <path…>
//
// It never rewrites the file it is handed: the collector's own JSON is already
// valid, and this fixture is about the exit status, not about formatting.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [counterPath, failOn] = process.argv.slice(2);
const seen = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
const call = seen + 1;
writeFileSync(counterPath, String(call));
if (call === Number(failOn)) {
  process.stderr.write(`counting-formatter: refusing call ${call}\n`);
  process.exit(7);
}
