/**
 * The single source of acceptance-row ids (p5 D6).
 *
 * One entry per row of `docs/acceptance/v1.md` — every "Required end-to-end
 * flow" bullet and every "Verification matrix" row — with what backs it:
 *
 *   id          stable slug, used by the collector and the evidence document
 *   row         the v1.md row exactly: the matrix row's Area cell, or the flow
 *               bullet's first sentence. `test/acceptance-matrix.test.ts`
 *               asserts this mapping is 1:1, so a row added to v1.md without an
 *               entry here (or the reverse) fails `bun run verify`.
 *   disposition unit | process | cli | live | limit
 *   tests       `{ file, name }` per backing test. `name` is vitest's
 *               `fullName`: the describe titles and the `it` title joined by
 *               single spaces. Keyed this way because that is what
 *               `--reporter=json` emits per assertion; it does mean renaming a
 *               `describe` unbacks every row that names a test inside it, which
 *               `test/acceptance-matrix.test.ts` catches at once.
 *   gates       `"<log basename>:<gate id>"` per live gate, read from the
 *               committed `docs/research/*.log` as `GATE <id> PASS`.
 *   command     what a reader runs to see it for themselves
 *   note        why, when the row needs one; required for `limit`
 *   predicate   optional id into PREDICATES: a pure check over a journal that
 *               says what shape of run the row is about. At least one cited
 *               test must assert it on its own journal
 *               (`test/acceptance-matrix.test.ts`), so a row cannot cite a test
 *               that merely passes near the topic (F-012).
 *
 * A `limit` row is backed by neither: it is a documented gap, and
 * `docs/acceptance/v1-evidence.md` must carry its reason.
 */

export const DISPOSITIONS = ["unit", "process", "cli", "live", "limit"];

const BR = "build-review-live.log";
const PBR = "plan-build-review-live.log";
const EXT = "external-workflow-live.log";
const PI = "product-integration-live.log";
const LOSS = "runtime-loss-live.log";

/** Live logs an entry may name; the collector reads these from docs/research/. */
export const LIVE_LOGS = [BR, PBR, EXT, PI, LOSS];

const t = (file, name) => ({ file, name });

export const MATRIX = [
  // ── Required end-to-end flow ────────────────────────────────────────────
  {
    id: "flow-identity",
    row: "The same builder identity and native session perform build and repair",
    disposition: "live",
    tests: [
      t(
        "test/scheduler.process.test.ts",
        "scheduler scenarios (scripted runtime, real processes) 1. happy path: identity continuity, handoff and the completion gate",
      ),
    ],
    gates: [`${BR}:4`, `${PBR}:4`],
    command: "node scripts/live/build-review.mjs",
    note: "",
  },
  {
    id: "flow-substantive-artifacts",
    row: "Both reviews produce substantive artifacts tied to the corresponding changes",
    disposition: "live",
    tests: [],
    gates: [`${BR}:5`, `${BR}:6`, `${PBR}:5`, `${PBR}:6`],
    command: "node scripts/live/build-review.mjs",
    note: "Artifact substance is read by hand and recorded in the log; no test can assert it.",
  },
  {
    id: "flow-failed-review",
    row: "A valid failed review completes the review stage and triggers repair",
    disposition: "live",
    tests: [
      t(
        "test/scheduler.process.test.ts",
        "scheduler scenarios (scripted runtime, real processes) 2. a failed review is a completed review that routes to repair",
      ),
    ],
    gates: [`${BR}:5`, `${PBR}:5`],
    command: "bun x vitest run test/scheduler.process.test.ts",
    note: "",
  },
  {
    id: "flow-final-gate",
    row: "The final gate refers to the repaired change and passing review",
    disposition: "live",
    tests: [
      t(
        "test/scheduler.process.test.ts",
        "scheduler scenarios (scripted runtime, real processes) 4. a pass on a moved revision starts another round; completion names the builder's tree",
      ),
    ],
    gates: [`${BR}:7`, `${BR}:8`, `${PBR}:7`],
    command: "node scripts/live/build-review.mjs",
    note: "",
  },
  {
    id: "flow-observer-agreement",
    row: "Herdr status and an external observer agree with the SDK state while work is active, without parsing terminal text",
    disposition: "live",
    tests: [
      t(
        "test/live-observer.process.test.ts",
        "observerDisagreements (live gate 10) accepts the verify-4 samples, whose only disagreements fall within the grace window",
      ),
      t(
        "test/live-observer.process.test.ts",
        "observerDisagreements (live gate 10) flags working 20 s after acceptance, working with no acceptance, and gone while active",
      ),
    ],
    gates: [`${BR}:10`, `${PBR}:10`],
    command: "node scripts/live/build-review.mjs",
    note: "",
  },

  // ── Verification matrix ─────────────────────────────────────────────────
  {
    id: "input",
    row: "Input",
    disposition: "cli",
    tests: [
      t(
        "test/run-foreground.cli.test.ts",
        "woof run start --host foreground: usage and admission rejects invalid input before loading the runtime or writing a journal",
      ),
      t(
        "test/plan-build-review.cli.test.ts",
        "plan-build-review: the definition itself admits a bare input and refuses unknown fields, bad constraints and a too-large request",
      ),
      t(
        "test/unit/build-review-input.test.ts",
        "build-review input: the rendered request fits at admission rejects a context that is small compact but too large once pretty-printed into the request",
      ),
    ],
    gates: [],
    command:
      "bun x vitest run test/run-foreground.cli.test.ts test/plan-build-review.cli.test.ts test/unit/build-review-input.test.ts",
    note: "",
  },
  {
    id: "artifact-authority",
    row: "Artifact authority",
    disposition: "cli",
    tests: [
      t(
        "test/plan-build-review.cli.test.ts",
        "plan-build-review: a full run on the scripted runtime plans, builds, verifies, repairs after a failed review and completes, with the plan as an input everywhere",
      ),
      t(
        "test/scheduler.process.test.ts",
        "scheduler blocking, delivery, cancellation and failures 12. an altered accepted review fails the run before any repair is opened or sent",
      ),
    ],
    gates: [`${BR}:6`, `${PBR}:6`],
    command: "bun x vitest run test/plan-build-review.cli.test.ts",
    note: "",
  },
  {
    id: "required-output",
    row: "Required output",
    disposition: "cli",
    tests: [
      t(
        "test/engine-paths.cli.test.ts",
        "non-regular artifact entries reports a FIFO submitted as the artifact as artifact_missing without blocking",
      ),
      t(
        "test/engine-paths.cli.test.ts",
        "artifact stability rejects an artifact that changes size while it is read as artifact_hash_mismatch",
      ),
      t(
        "test/scheduler.process.test.ts",
        "scheduler scenarios (scripted runtime, real processes) 3. gates only on validated control data: a rejected claim or no submission never gates",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/engine-paths.cli.test.ts test/scheduler.process.test.ts",
    note: "",
  },
  {
    id: "consistency",
    row: "Consistency",
    disposition: "process",
    tests: [
      t(
        "test/artifact-verdict.process.test.ts",
        "check 17b: an artifact verdict marker that disagrees with the envelope rejects it as verdict_artifact_mismatch, naming both, with no accepted copy",
      ),
      t(
        "test/artifact-verdict.process.test.ts",
        "check 17b: an artifact verdict marker that disagrees with the envelope ignores a marker-looking line that is not the first: the anchor holds",
      ),
      t(
        "test/precedence.cli.test.ts",
        "submitResult check precedence a verdict marker mismatch is the last check before publication",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/artifact-verdict.process.test.ts",
    note: "p5 D5 ships the opt-in marker; the row is backed by process evidence, not by a live run.",
  },
  {
    id: "format-repair",
    row: "Format repair",
    disposition: "process",
    predicate: "format-repair-corrected",
    tests: [
      t(
        "test/scheduler.process.test.ts",
        "scheduler scenarios (scripted runtime, real processes) 3. gates only on validated control data: a rejected claim or no submission never gates",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/scheduler.process.test.ts",
    note: "",
  },
  {
    id: "exhausted-repair",
    row: "Exhausted repair",
    disposition: "process",
    predicate: "format-repair-exhausted",
    tests: [
      t(
        "test/scheduler.process.test.ts",
        "scheduler bounds (each expired bound is exhausted with its limit) 6i. maxFormatRepairs: a reviewer whose every envelope is schema-invalid is exhausted, and each format repair quotes envelope_invalid",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/scheduler.process.test.ts",
    note: "",
  },
  {
    id: "duplicates",
    row: "Duplicates",
    disposition: "process",
    tests: [
      t(
        "test/scripted-runtime.process.test.ts",
        "scripted runtime with the store: duplicate delivery records one ambiguous dispatch, refuses a second, and dedupes the worker's repeated submission",
      ),
      t(
        "test/journal.process.test.ts",
        "run journal under concurrent submitters accepts exactly one of eight identical concurrent submissions",
      ),
      t(
        "test/scheduler.process.test.ts",
        "scheduler blocking, delivery, cancellation and failures 10. an identical duplicate submission is recorded once and gated once",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/journal.process.test.ts test/scripted-runtime.process.test.ts",
    note: "",
  },
  {
    id: "correlation",
    row: "Correlation",
    disposition: "process",
    tests: [
      t(
        "test/scripted-runtime.process.test.ts",
        "scripted runtime with the store: duplicate delivery allows trying again only as an explicit new attempt, and keeps the old attempt's late result out",
      ),
      t(
        "test/journal-integrity.process.test.ts",
        "journal integrity fails closed on an acceptance whose agent disagrees with the opened attempt",
      ),
      t(
        "test/scheduler.process.test.ts",
        "scheduler scenarios (scripted runtime, real processes) 5. a late pass for a superseded attempt is stale and never completes the run",
      ),
    ],
    gates: [],
    command:
      "bun x vitest run test/journal-integrity.process.test.ts test/scripted-runtime.process.test.ts",
    note: "",
  },
  {
    id: "runtime-state",
    row: "Runtime state",
    disposition: "process",
    tests: [
      t(
        "test/scripted-runtime.process.test.ts",
        "scripted runtime with the store: stale signals does not complete an attempt when the agent is observed ready, and ignores a late ready after acceptance",
      ),
      t(
        "test/scheduler.process.test.ts",
        "scheduler bounds (each expired bound is exhausted with its limit) 6d. maxAttemptsPerVisit: undelivered work is retried in one new attempt",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/scripted-runtime.process.test.ts",
    note: "",
  },
  {
    id: "delivery",
    row: "Delivery",
    disposition: "process",
    tests: [
      t(
        "test/scheduler.process.test.ts",
        "scheduler bounds (each expired bound is exhausted with its limit) 6g. deliveryTimeoutMs: an ambiguous delivery without evidence is abandoned, never resent",
      ),
      t(
        "test/scheduler.process.test.ts",
        "scheduler blocking, delivery, cancellation and failures 8. an ambiguous delivery followed by observed work is reconciled delivered and completes",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/scheduler.process.test.ts",
    note: "",
  },
  {
    id: "blocking",
    row: "Blocking",
    disposition: "process",
    tests: [
      t(
        "test/scheduler.process.test.ts",
        "scheduler blocking, delivery, cancellation and failures 7. a blocked reviewer names the pane and the cancel command, and resumes when unblocked",
      ),
      t(
        "test/scheduler.process.test.ts",
        "scheduler bounds (each expired bound is exhausted with its limit) 6f. blockedWaitMs: a block is journaled, then the wait expires",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/scheduler.process.test.ts",
    note: "A live block is opportunistic (lead decision Q5); its absence is recorded in the live log, and nobody provokes or answers a permission prompt.",
  },
  {
    id: "failure",
    row: "Failure",
    disposition: "process",
    tests: [
      t(
        "test/scheduler.process.test.ts",
        "scheduler blocking, delivery, cancellation and failures 11. a gone or replaced agent fails the run",
      ),
      t(
        "test/scheduler.process.test.ts",
        "scheduler blocking, delivery, cancellation and failures 13. a builder that reports status failed ends the run and names the stage",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/scheduler.process.test.ts",
    note: "",
  },
  {
    id: "limits",
    row: "Limits",
    disposition: "process",
    tests: [
      t(
        "test/scheduler.process.test.ts",
        "scheduler bounds (each expired bound is exhausted with its limit) 6b. maxVisitsPerStage: a check that always fails stops repair at two visits, before any review",
      ),
      t(
        "test/scheduler.process.test.ts",
        "scheduler bounds (each expired bound is exhausted with its limit) 6h. runTimeoutMs: a worker that works forever ends the run at the run timeout",
      ),
      t(
        "test/scheduler.process.test.ts",
        "scheduler bounds (each expired bound is exhausted with its limit) 6e. readinessWaitMs: an agent that never becomes ready gets no attempt",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/scheduler.process.test.ts",
    note: "",
  },
  {
    id: "cancellation",
    row: "Cancellation",
    disposition: "process",
    tests: [
      t(
        "test/scheduler.process.test.ts",
        "scheduler blocking, delivery, cancellation and failures 9. cancellation stops owned panes and a late result cannot resurrect the run",
      ),
      t(
        "test/run-foreground.cli.test.ts",
        "woof run start --host foreground: runs exits 6 on SIGTERM, records the cancellation and refuses a late submission",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/scheduler.process.test.ts test/run-foreground.cli.test.ts",
    note: "",
  },
  {
    id: "observation",
    row: "Observation",
    disposition: "process",
    tests: [
      t(
        "test/observe.process.test.ts",
        "event subscription across a reconnect misses no transition when the observer is killed and resumes from its stored cursor",
      ),
      t(
        "test/unit/events.test.ts",
        "snapshot and events consistency fold(snapshot@N, events after N) equals a fresh snapshot for 200 seeded journals at every split",
      ),
      t(
        "test/observe.process.test.ts",
        "resuming against a replaced run directory requires a resync instead of resuming into another run",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/observe.process.test.ts test/unit/events.test.ts",
    note: "",
  },
  {
    id: "runtime-loss",
    row: "Runtime loss",
    disposition: "live",
    tests: [
      t(
        "test/host.process.test.ts",
        "p5 C3: the probe checks a hosting claim's fields, not only their presence refuses a startedAt that is not a date, and defers to the heartbeat for a foreign hostname",
      ),
    ],
    gates: [`${LOSS}:L7`],
    command: "node scripts/live/runtime-loss.mjs",
    note: "`scripts/live/product-integration.mjs` prints `GATE L7 MANUAL` — a placeholder the collector correctly refuses to read as PASS, so nothing could ever close this row from a script's own output (p5 repair PB-003). `scripts/live/runtime-loss.mjs` performs the procedure and prints `GATE L7 PASS|FAIL`. The stale journal lock after a kill is a separate documented limit (carry-over C1): the probe waits for the lock to be absent before killing, so it never exercises it.",
  },
  {
    id: "configuration",
    row: "Configuration",
    disposition: "process",
    tests: [
      t(
        "test/config.process.test.ts",
        "woof config show: configuration matrix C2: a project role replaces the user role whole",
      ),
      t(
        "test/config.process.test.ts",
        "woof config show: configuration matrix C3: limits compose per key across input, project, user and built-in, recorded in config.json",
      ),
      t(
        "test/config.process.test.ts",
        "woof config show: configuration matrix C7 (admission): a used role with an unsupported kind is rejected naming its file; an unused one only warns",
      ),
      t(
        "test/config.process.test.ts",
        "woof config show: configuration matrix C19 (recorded): a permission bypass in a role runs as configured and config.json carries the warning",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/config.process.test.ts",
    note: "",
  },
  {
    id: "reuse",
    row: "Reuse",
    disposition: "cli",
    tests: [
      t(
        "test/plan-build-review.cli.test.ts",
        "plan-build-review: the definition itself validates against the p3 definition contract with no engine change",
      ),
      t(
        "test/external-workflow.process.test.ts",
        "an external project workflow loads, admits and runs runs scribe end to end from the project .woof, with roundStage null and no limitDefaults",
      ),
      t(
        "test/boundaries.process.test.ts",
        "module boundaries in dist names no built-in stage and appends no journal record in dist/scheduler",
      ),
      t(
        "test/unit/config-resolve.test.ts",
        "configuration composition serves every built-in workflow and role from the catalog, with no name in a branch (p5 D2)",
      ),
    ],
    gates: [`${PBR}:1`, `${EXT}:1`],
    command:
      "bun x vitest run test/plan-build-review.cli.test.ts test/external-workflow.process.test.ts test/boundaries.process.test.ts",
    note: "",
  },
  {
    id: "optional-adapters",
    row: "Optional adapters",
    disposition: "process",
    tests: [
      t(
        "test/boundaries.process.test.ts",
        "module boundaries in dist follows the one-way import rules and imports no packages",
      ),
      t(
        "test/boundaries.process.test.ts",
        "module boundaries in dist lets only cli.ts and other command handlers import commands/",
      ),
      t(
        "test/sdk.process.test.ts",
        "SDK result handoff opens an attempt and submits through the built package without the CLI",
      ),
      t(
        "test/acceptance-matrix.test.ts",
        "the acceptance matrix the acceptance matrix names no MCP adapter anywhere in src/",
      ),
    ],
    gates: [],
    command: "bun x vitest run test/boundaries.process.test.ts test/sdk.process.test.ts",
    note: "The same evidence closes the first half of the decision record's Module/package-layout row: the engine imports no plugin or UI module, and the SDK runs a workflow with no Woof UI.",
  },
];

/** Rejections that name an attempt the submitter does not own; never the owner's (F-015). */
const FOREIGN_REJECTIONS = new Set(["owner_mismatch"]);

const attemptKey = (record) => `${record.stageId}/${record.visit}/${record.attempt}`;

/**
 * The attempts of a journal with what the predicates need: agent, whether the
 * previous attempt of the visit makes this one a format repair (the reducer's
 * rule: that attempt was not accepted and its dispatch started, or was ambiguous
 * and reconciled delivered), the owner's identity-bearing rejections, and
 * acceptance. Pure: reads plain journal records, imports nothing.
 */
function attemptsOf(journal) {
  const attempts = new Map();
  const latestByStage = new Map();
  const dispatches = new Map();
  const reconciled = new Map();
  for (const record of journal) {
    if (record.type === "attempt.opened") {
      const latest = latestByStage.get(record.stageId);
      let cause = "initial";
      if (latest !== undefined && latest.visit === record.visit) {
        const dispatch = dispatches.get(attemptKey(latest));
        cause =
          latest.accepted !== true &&
          dispatch !== undefined &&
          (dispatch.delivery === "started" ||
            (dispatch.delivery === "ambiguous" && reconciled.get(dispatch.seq) === "delivered"))
            ? "format_repair"
            : "work_retry";
      }
      const attempt = {
        ...record,
        cause,
        previous: latest !== undefined && latest.visit === record.visit ? latest : null,
        rejections: [],
        accepted: false,
      };
      attempts.set(attemptKey(record), attempt);
      latestByStage.set(record.stageId, attempt);
    } else if (record.type === "request.dispatched") {
      dispatches.set(attemptKey(record), record);
    } else if (record.type === "delivery.reconciled") {
      reconciled.set(record.dispatchSeq, record.resolution);
    } else if (record.type === "submission.accepted") {
      const attempt = attempts.get(attemptKey(record));
      if (attempt !== undefined) attempt.accepted = true;
    } else if (record.type === "submission.rejected" && record.identity !== undefined) {
      const attempt = attempts.get(attemptKey(record.identity));
      if (
        attempt !== undefined &&
        record.identity.agentId === attempt.agentId &&
        !FOREIGN_REJECTIONS.has(record.reason)
      ) {
        attempt.rejections.push(record.reason);
      }
    }
  }
  return [...attempts.values()];
}

/**
 * Journal predicates a matrix row names with `predicate` (F-012). Each takes the
 * journal as an array of parsed records and returns a boolean.
 */
export const PREDICATES = {
  /**
   * Format repair: the worker submitted invalid control data, the rejection was
   * journaled against its attempt, and the format-repair attempt that followed
   * was accepted.
   */
  "format-repair-corrected": (journal) =>
    attemptsOf(journal).some(
      (attempt) =>
        attempt.cause === "format_repair" &&
        attempt.accepted &&
        attempt.previous !== null &&
        attempt.previous.rejections.length > 0,
    ),
  /**
   * Exhausted repair: in one visit, at least two attempts each carry an owner's
   * rejected submission, and the run ended exhausted on maxFormatRepairs.
   */
  "format-repair-exhausted": (journal) => {
    const rejectedPerVisit = new Map();
    for (const attempt of attemptsOf(journal)) {
      if (attempt.rejections.length === 0) continue;
      const visit = `${attempt.stageId}/${attempt.visit}`;
      rejectedPerVisit.set(visit, (rejectedPerVisit.get(visit) ?? 0) + 1);
    }
    const terminated = journal.findLast((record) => record.type === "run.terminated");
    return (
      [...rejectedPerVisit.values()].some((count) => count >= 2) &&
      terminated?.outcome === "exhausted" &&
      terminated.limit === "maxFormatRepairs"
    );
  },
};
