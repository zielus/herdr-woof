// The run snapshot the live scripts sample and record, read with the built SDK's `readSnapshot`
// (pass it in: each script loads dist/ its own way). The result keeps the `{outcome, snapshot}`
// line the removed `woof run show` printed, so recorded evidence stays comparable across runs.

/** `{status, stdout, json}`: status 0 with the snapshot, 3 with the rejection. */
export function showRun(readSnapshot, runDir, { verifyArtifacts = false } = {}) {
  const read = readSnapshot(runDir, { verifyArtifacts });
  const json = read.ok
    ? { outcome: "snapshot", snapshot: read.snapshot }
    : { outcome: "rejected", reason: read.reason, message: read.message };
  return { status: read.ok ? 0 : 3, stdout: `${JSON.stringify(json)}\n`, json };
}
