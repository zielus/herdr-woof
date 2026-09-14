import { afterEach, describe, expect, it } from "vitest";

import { cleanupRunDirs, distIndexUrl, makeRunDir, runNode } from "./helpers/process.js";

afterEach(() => cleanupRunDirs());

describe("SDK result handoff", () => {
  it("opens an attempt and submits through the built package without the CLI", () => {
    const runDir = makeRunDir();
    const script = `
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const sdk = await import(${JSON.stringify(distIndexUrl)});
const runDir = process.argv[1];
const opened = await sdk.openAttempt({
  runDir, runId: "sdk-run", agentId: "sdk-worker", stageId: "report",
  visit: 1, attempt: 1, verdicts: ["pass"], paneId: "w1:p1",
});
const content = "# SDK report\\n\\nSubmitted without the CLI.\\n";
writeFileSync(opened.attempt.artifactDir + "/report.md", content);
const envelope = {
  schemaVersion: 1, runId: "sdk-run", agentId: "sdk-worker", stageId: "report",
  visit: 1, attempt: 1, status: "completed", verdict: "pass",
  artifact: {
    path: "artifacts/report/visit-1/attempt-1/report.md",
    sha256: createHash("sha256").update(content).digest("hex"),
  },
};
const wrongPane = await sdk.submitResult({ runDir, envelopeRaw: JSON.stringify(envelope), paneId: "w1:p9" });
const accepted = await sdk.submitResult({ runDir, envelopeRaw: JSON.stringify(envelope), paneId: "w1:p1" });
// No paneId argument: the SDK must not read HERDR_PANE_ID from the environment.
const duplicate = await sdk.submitResult({ runDir, envelopeRaw: new TextEncoder().encode(JSON.stringify(envelope)) });
const read = sdk.readJournal(runDir);
console.log(JSON.stringify({
  opened: opened.outcome, wrongPane, accepted, duplicate,
  types: read.records.map((record) => record.type),
}));
`;

    const result = runNode(script, [runDir], { env: { HERDR_PANE_ID: "w1:p9" } });

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      opened: string;
      wrongPane: { outcome: string; reason: string };
      accepted: { outcome: string; receipt: { receiptId: string } };
      duplicate: { outcome: string; receipt: { receiptId: string } };
      types: string[];
    };
    expect(output.opened).toBe("opened");
    expect(output.wrongPane).toMatchObject({ outcome: "rejected", reason: "owner_mismatch" });
    expect(output.accepted.outcome).toBe("accepted");
    expect(output.duplicate.outcome).toBe("duplicate");
    expect(output.duplicate.receipt).toEqual(output.accepted.receipt);
    expect(output.types).toEqual([
      "run.opened",
      "attempt.opened",
      "submission.rejected",
      "submission.accepted",
      "submission.duplicate",
    ]);
  });
});
