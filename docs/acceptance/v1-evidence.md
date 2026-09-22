# Woof v1 acceptance evidence

Revision: the live evidence was recorded on the `feat/plan-build-review` branch at
`5e0236e6d06152222e6ff35f80dc05889841d4c2`, merged as PR #7 (`b329cdc`, 0.1.0). Master does not
contain `5e0236e` itself; it is kept here as a historical id, never as something to check out. Two
source fixes landed on that branch after the live runs and are part of `b329cdc`: check 17b scans
to the real first non-blank line (`src/submission/submit.ts`), and quoted rejections in a
format-repair request are bounded (`src/scheduler/request.ts`, `src/workflows/request-bound.ts`).
The live runs were not repeated after them. The offline half (`offline.json`) was re-collected in
this phase at commit `5c152f7` (24/24 rows backed, exit 0). The previous real collect was on the
0.1.0 code in PR #8 (merged as `ecac163`) at branch commit `79a79cb` on `feat/public-readiness`;
that id is now historical only. `offline.json`'s `revision` field is the commit at collection time,
which after a squash merge is always a branch commit, not the merge commit itself — expected
behavior of the collector, not a defect. · Date: 2026-09-16
`bun run verify`: 718 tests green, run twice, at `5e0236e6d0…` (product code
only); `test/acceptance-evidence.test.ts` itself then adds test cases on top of
that revision, so the total moves with this file — reproduce it with `bun run
verify` at whatever commit holds this exact document, not by pinning a count
here to a revision that predates the test.
Versions: node v26.7.0, bun 1.3.2, git 2.51.2, herdr 0.9.0, claude 2.1.273 (Claude Code)

This document mirrors `docs/acceptance/v1.md`'s matrix one row at a time.
`scripts/acceptance/matrix.mjs` is the single source of the row → evidence
mapping; `test/acceptance-matrix.test.ts` checks that mapping stays 1:1 with
`v1.md`, and `test/acceptance-evidence.test.ts` checks that this file covers
every row and every limit named below. `bun run acceptance:collect` re-derives
`docs/acceptance/evidence/offline.json` from the same matrix against the
committed logs below and the test suite; at `5c152f7` (this phase) it reports
24/24 rows backed, exit 0.

Live evidence comes from five committed logs under `docs/research/`:
`build-review-live.log` (round 2, replacing the p3/round-1 log per carry-over
C5), `plan-build-review-live.log` (round 2), `external-workflow-live.log`
(round 1, unchanged — the scribe path did not change in round 2),
`runtime-loss-live.log` (round 2, `scripts/live/runtime-loss.mjs`'s first real
execution), and `product-integration-live.log` (the p4 round-6 log, carried
forward per lead decision Q4). The full run-by-run narrative, including the
round-1 L-BR finding and the fixture-ordering procedure defect, lived in the
verifier's `live/INDEX.md` in the phase's run directory, which is not part of
this repository; this file states only what the committed logs and the test
suite back.

The public-readiness change (phase 6) redacted all seven committed logs under
`docs/research/`: the home directory prefix became `~` and the host name became
`<host>`. The edit is line-preserving, so every `log:line` citation below still
holds; pane, terminal and session ids, timestamps and every gate verdict are unchanged.

## Required end-to-end flow

| Requirement                                                                                                                                         | Evidence                                                                                                                                                                                                           | Command                                           | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The same builder identity and native session perform build and repair; the reviewer retains its identity across both reviews.                       | `test/scheduler.process.test.ts` "…1. happy path: identity continuity, handoff and the completion gate"; `build-review-live.log:4`, `plan-build-review-live.log:4`                                                 | `node scripts/live/build-review.mjs`              | PASS. Gate 4 passes in both round-2 logs: one builder pane/session and one reviewer pane/session throughout each run (L-BR: builder `w8T:pG`, reviewer `w8T:pH`; L-PBR: planner `w8T:pJ`, builder `w8T:pK`, reviewer `w8T:pM`, one identity each).                                                                                                                                                                                                                                                       |
| Both reviews produce substantive artifacts tied to the corresponding changes; the builder reads the first accepted artifact directly during repair. | `build-review-live.log:5`, `build-review-live.log:6`, `plan-build-review-live.log:5`, `plan-build-review-live.log:6` (no test asserts prose substance)                                                             | `node scripts/live/build-review.mjs`              | PASS, hand-inspected. Both L-BR reviews cite the concrete missing marker line and independently re-verify every acceptance criterion; the repaired code is the builder's own change (LV-102's canonical-review sentence produced "satisfy and record an objection", not a reviewer-authored fix). L-PBR's plan is a real file-level plan, not a restatement of the acceptance criteria.                                                                                                                  |
| A valid failed review completes the review stage and triggers repair; it does not masquerade as a runtime failure.                                  | `test/scheduler.process.test.ts` "…2. a failed review is a completed review that routes to repair"; `build-review-live.log:5`, `plan-build-review-live.log:5`                                                      | `bun x vitest run test/scheduler.process.test.ts` | PASS. Gate 5 passes in both round-2 logs: review 1's `fail` verdict is a completed review that routes to `repair`, not a worker failure.                                                                                                                                                                                                                                                                                                                                                                 |
| The final gate refers to the repaired change and passing review; structured completion and artifact references reach the caller.                    | `test/scheduler.process.test.ts` "…4. a pass on a moved revision starts another round; completion names the builder's tree"; `build-review-live.log:7`, `build-review-live.log:8`, `plan-build-review-live.log:7`  | `node scripts/live/build-review.mjs`              | PASS. Round-1's L-BR failed gates 7/8 (review never reached `pass`, hence `exhausted`) even though tree agreement and repository effects were already correct; round 2 (LV-102 fix + rerun) passes both: the last review passes on the exact repaired tree, the marker line is present and `node --test`/`node --test` (scribe/slugify/title-case fixtures) pass.                                                                                                                                        |
| Herdr status and an external observer agree with the SDK state while work is active, without parsing terminal text.                                 | `test/live-observer.process.test.ts` "observerDisagreements (live gate 10) accepts the verify-4 samples…" and "…flags working 20 s after acceptance…"; `build-review-live.log:10`, `plan-build-review-live.log:10` | `node scripts/live/build-review.mjs`              | PASS. Gate 10: L-BR round 2, 34 samples, 0 disagreeing; L-PBR round 2, 69 samples, 0 disagreeing. `test/live-observer.process.test.ts`'s pinned case was re-derived against the round-2 `build-review-live.log` (34 samples, one grace-window-only soft disagreement at `2026-09-16T02:30:57.187Z`, none once the grace window applies) after this phase replaced the committed log; the case still asserts the observer accepts the committed evidence, now against the log that is actually committed. |

## Verification matrix

| Row                | Disposition             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Command                                                                                                                      | Observed result                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Input              | `cli`                   | `test/run-build-review.cli.test.ts` "usage and admission rejects invalid input…"; `test/plan-build-review.cli.test.ts` "the definition itself admits a bare input and refuses unknown fields, bad constraints and a too-large request"; `test/unit/build-review-input.test.ts` "the rendered request fits at admission rejects a context that is small compact but too large…"                                                                                                                                                                               | `bun x vitest run test/run-build-review.cli.test.ts test/plan-build-review.cli.test.ts test/unit/build-review-input.test.ts` | PASS. Valid input reaches the request intact for both workflows; invalid input, an oversize context, and an over-large rendered request are all refused before any worker launches.                                                                                                                                                                                      |
| Artifact authority | `cli` + `live`          | `test/plan-build-review.cli.test.ts` "a full run on the scripted runtime plans, builds, verifies, repairs after a failed review and completes, with the plan as an input everywhere"; `test/scheduler.process.test.ts` "…12. an altered accepted review fails the run before any repair is opened or sent"; `build-review-live.log:6`, `plan-build-review-live.log:6`                                                                                                                                                                                        | `bun x vitest run test/plan-build-review.cli.test.ts`                                                                        | PASS. The plan reaches every builder turn (build and repair) as an `InputRef` by path/receipt/sha256, never inlined; live gate 6 confirms this against real agent requests in both workflows.                                                                                                                                                                            |
| Required output    | `cli`                   | `test/engine-paths.cli.test.ts` "…reports a FIFO submitted as the artifact as artifact_missing without blocking"; "…rejects an artifact that changes size while it is read as artifact_hash_mismatch"; `test/scheduler.process.test.ts` "…3. gates only on validated control data: a rejected claim or no submission never gates"                                                                                                                                                                                                                            | `bun x vitest run test/engine-paths.cli.test.ts test/scheduler.process.test.ts`                                              | PASS. A missing, partial, stale or structurally invalid artifact produces no accepted stage completion and no gate transition.                                                                                                                                                                                                                                           |
| Consistency        | `process` (D5, shipped) | `test/artifact-verdict.process.test.ts` "check 17b: an artifact verdict marker that disagrees with the envelope rejects it as verdict_artifact_mismatch, naming both, with no accepted copy" and "…ignores a marker-looking line that is not the first: the anchor holds"; `test/precedence.cli.test.ts` "a verdict marker mismatch is the last check before publication"                                                                                                                                                                                    | `bun x vitest run test/artifact-verdict.process.test.ts`                                                                     | PASS. The opt-in, first-line-anchored `artifactVerdictMarker` (check 17b, `src/submission/submit.ts`) shipped; the R9 cut was not taken. 10 cases in `artifact-verdict.process.test.ts` all pass, including the two additivity checks (exact-key record validation with and without the field; the p1/p2 fixture journals still replay clean).                           |
| Format repair      | `process`               | `test/scheduler.process.test.ts` "…3. gates only on validated control data: a rejected claim or no submission never gates"                                                                                                                                                                                                                                                                                                                                                                                                                                   | `bun x vitest run test/scheduler.process.test.ts`                                                                            | PASS. A worker's schema-invalid first submission (`artifact_hash_mismatch`) gets one format-repair attempt in the same visit, which is accepted and gates.                                                                                                                                                                                                               |
| Exhausted repair   | `process`               | `test/scheduler.process.test.ts` "…6i. maxFormatRepairs: a reviewer whose every envelope is schema-invalid is exhausted, and each format repair quotes envelope_invalid"                                                                                                                                                                                                                                                                                                                                                                                     | `bun x vitest run test/scheduler.process.test.ts`                                                                            | PASS. A reviewer that never submits a schema-valid envelope exhausts `maxFormatRepairs`, and every format-repair request quotes `envelope_invalid`.                                                                                                                                                                                                                      |
| Duplicates         | `process`               | `test/scripted-runtime.process.test.ts` "duplicate delivery records one ambiguous dispatch, refuses a second, and dedupes the worker's repeated submission"; `test/journal.process.test.ts` "run journal under concurrent submitters accepts exactly one of eight identical concurrent submissions"; `test/scheduler.process.test.ts` "…10. an identical duplicate submission is recorded once and gated once"                                                                                                                                               | `bun x vitest run test/journal.process.test.ts test/scripted-runtime.process.test.ts`                                        | PASS.                                                                                                                                                                                                                                                                                                                                                                    |
| Correlation        | `process`               | `test/scripted-runtime.process.test.ts` "…allows trying again only as an explicit new attempt, and keeps the old attempt's late result out"; `test/journal-integrity.process.test.ts` "fails closed on an acceptance whose agent disagrees with the opened attempt"; `test/scheduler.process.test.ts` "…5. a late pass for a superseded attempt is stale and never completes the run"                                                                                                                                                                        | `bun x vitest run test/journal-integrity.process.test.ts test/scripted-runtime.process.test.ts`                              | PASS.                                                                                                                                                                                                                                                                                                                                                                    |
| Runtime state      | `process`               | `test/scripted-runtime.process.test.ts` "stale signals does not complete an attempt when the agent is observed ready, and ignores a late ready after acceptance"; `test/scheduler.process.test.ts` "…6d. maxAttemptsPerVisit: undelivered work is retried in one new attempt"                                                                                                                                                                                                                                                                                | `bun x vitest run test/scripted-runtime.process.test.ts`                                                                     | PASS.                                                                                                                                                                                                                                                                                                                                                                    |
| Delivery           | `process`               | `test/scheduler.process.test.ts` "…6g. deliveryTimeoutMs: an ambiguous delivery without evidence is abandoned, never resent"; "…8. an ambiguous delivery followed by observed work is reconciled delivered and completes"                                                                                                                                                                                                                                                                                                                                    | `bun x vitest run test/scheduler.process.test.ts`                                                                            | PASS.                                                                                                                                                                                                                                                                                                                                                                    |
| Blocking           | `process`               | `test/scheduler.process.test.ts` "…7. a blocked reviewer names the pane and the cancel command, and resumes when unblocked"; "…6f. blockedWaitMs: a block is journaled, then the wait expires"                                                                                                                                                                                                                                                                                                                                                               | `bun x vitest run test/scheduler.process.test.ts`                                                                            | PASS. No `run.blocked` occurred in any of the four p5 live runs; per lead decision Q5 a live block is opportunistic, and its absence is recorded here rather than substituted with a provoked or answered permission prompt.                                                                                                                                             |
| Failure            | `process`               | `test/scheduler.process.test.ts` "…11. a gone or replaced agent fails the run"; "…13. a builder that reports status failed ends the run and names the stage"                                                                                                                                                                                                                                                                                                                                                                                                 | `bun x vitest run test/scheduler.process.test.ts`                                                                            | PASS.                                                                                                                                                                                                                                                                                                                                                                    |
| Limits             | `process`               | `test/scheduler.process.test.ts` "…6b. maxVisitsPerStage: a check that always fails stops repair at two visits, before any review"; "…6h. runTimeoutMs: a worker that works forever ends the run at the run timeout"; "…6e. readinessWaitMs: an agent that never becomes ready gets no attempt"                                                                                                                                                                                                                                                              | `bun x vitest run test/scheduler.process.test.ts`                                                                            | PASS.                                                                                                                                                                                                                                                                                                                                                                    |
| Cancellation       | `process`               | `test/scheduler.process.test.ts` "…9. cancellation stops owned panes and a late result cannot resurrect the run"; `test/run-build-review.cli.test.ts` "runs exits 6 on SIGTERM, records the cancellation and refuses a late submission"                                                                                                                                                                                                                                                                                                                      | `bun x vitest run test/scheduler.process.test.ts test/run-build-review.cli.test.ts`                                          | PASS. Cancellation stops owned panes and a late result cannot resurrect the run; a SIGTERM'd run records the cancellation and refuses a late submission.                                                                                                                                                                                                                 |
| Observation        | `process`               | `test/observe.process.test.ts` "misses no transition when the observer is killed and resumes from its stored cursor"; `test/unit/events.test.ts` "fold(snapshot@N, events after N) equals a fresh snapshot for 200 seeded journals at every split"; `test/observe.process.test.ts` "resuming against a replaced run directory requires a resync instead of resuming into another run"                                                                                                                                                                        | `bun x vitest run test/observe.process.test.ts test/unit/events.test.ts`                                                     | PASS.                                                                                                                                                                                                                                                                                                                                                                    |
| Runtime loss       | `live`                  | `test/host.process.test.ts` "p5 C3: the probe checks a hosting claim's fields…refuses a startedAt that is not a date, and defers to the heartbeat for a foreign hostname"; `runtime-loss-live.log:L7`                                                                                                                                                                                                                                                                                                                                                        | `node scripts/live/runtime-loss.mjs`                                                                                         | PASS, 8/8 steps. `GATE L7 PASS`: a killed host is reported `owner: "lost"`, `woof status --wait` exits 8, `woof run cancel` records the cancellation, no `host-exit.json` is written. First real execution of this script (round 1 only had the manual procedure and `product-integration.mjs`'s `GATE L7 MANUAL` placeholder, which the collector never reads as PASS). |
| Configuration      | `process`               | `test/config.process.test.ts` "C2: a project role replaces the user role whole"; "C3: limits compose per key across input, project, user and built-in, recorded in config.json"; "C7 (admission): a used role with an unsupported kind is rejected naming its file; an unused one only warns"; "C19 (recorded): a permission bypass in a role runs as configured and config.json carries the warning"                                                                                                                                                        | `bun x vitest run test/config.process.test.ts`                                                                               | PASS. Provenance is correct, invalid roles/kinds fail early, and the resolved configuration is stable for the life of a run.                                                                                                                                                                                                                                             |
| Reuse              | `live` + `cli`          | `test/plan-build-review.cli.test.ts` "validates against the p3 definition contract with no engine change"; `test/external-workflow.process.test.ts` "runs scribe end to end from the project .woof, with roundStage null and no limitDefaults"; `test/boundaries.process.test.ts` "names no built-in stage and appends no journal record in dist/scheduler"; `test/unit/config-resolve.test.ts` "serves every built-in workflow and role from the catalog, with no name in a branch (p5 D2)"; `plan-build-review-live.log:1`, `external-workflow-live.log:1` | `bun x vitest run test/plan-build-review.cli.test.ts test/external-workflow.process.test.ts test/boundaries.process.test.ts` | PASS. `plan-build-review` (built-in) and `scribe` (external, project-authored) both admit and run to completion with no per-workflow branch anywhere in the compiled engine.                                                                                                                                                                                             |
| Optional adapters  | `process`               | `test/boundaries.process.test.ts` "follows the one-way import rules and imports no packages"; "lets only cli.ts and other command handlers import commands/"; `test/sdk.process.test.ts` "opens an attempt and submits through the built package without the CLI"; `test/acceptance-matrix.test.ts` "the acceptance matrix names no MCP adapter anywhere in src/"                                                                                                                                                                                            | `bun x vitest run test/boundaries.process.test.ts test/sdk.process.test.ts`                                                  | PASS. No MCP server exists anywhere in `src/`; the engine imports no plugin/UI module; the SDK runs a full workflow (`runWorkflow`) through the built package with no Woof UI involved.                                                                                                                                                                                  |

## Documented limits

### Crash resume and re-hosting a lost run

Not implemented and not claimed. The journal is append-only and inspectable
(`journal.jsonl`, `readSnapshot`, `deriveRunResult`), but there is no
liveness-based takeover: nothing re-hosts a run whose owner process is gone.
`woof status` correctly reports the owner `lost` (verified live, L7, both
verification rounds) and `woof run cancel` records the cancellation, but no
process resumes scheduling that run. A takeover would mean one process
deleting another's lock on a liveness guess — the crash-recovery correctness
class this phase's non-goals explicitly exclude, and it would ship
untested-in-anger. _Falsified by_ a documented, live-verified recovery that
resumes an in-flight run rather than only diagnosing and cancelling it.

### C1 — stale journal lock after a kill in the release window

Fifth deferral (carry-over C1/C2), unchanged in p5. If a process holding the
journal lock is killed, the lock file is left behind: `woof run cancel`
against it waits 5 s and exits 3 `journal_busy`, naming the lock file and its
recorded holder. The documented manual recovery is `rm <runDir>/journal.lock`
followed by re-running `woof run cancel`; `test/lock-race.process.test.ts`
pins the race in-process. This phase's L7 probes
(`scripts/live/runtime-loss.mjs`, both rounds) deliberately wait for
`journal.lock` to be absent before killing the host, by design, so they never
exercise this path live — the evidence for the manual recovery is unchanged
from p4. _Falsified by_ a live run where the documented manual recovery does
not restore the ability to cancel.

### A second agent kind

Not exercised. The `RuntimeAdapter` interface (`openPane, startAgent, observe,
waitFor, deliver, stop`) is the capability boundary, implemented today only by
`createHerdrCliRuntime` (over `claude` through Herdr) and the in-memory
`createScriptedRuntime` test double. Nothing in this phase adds or exercises a
second real provider kind. _Falsified by_ a live run against a second agent
kind through the same `RuntimeAdapter` contract with no engine change.

### Parallel scheduling

Not implemented and not claimed. The engine runs one active request per agent
and one sequential decision loop (`decide(view) -> Action`, one action per
tick); nothing in this phase's workflows or tests exercises concurrent
dispatch within a run. `plan-build-review`'s three agents (planner, builder,
reviewer) run in sequence, one stage visit at a time, not in parallel.
_Falsified by_ a workflow that dispatches two agents concurrently and the
scheduler reconciling both without serializing them.

### MCP

No MCP server exists anywhere in the shipped engine (`test/acceptance-matrix.test.ts`
greps `src/` for the literal `mcp`, case-insensitively, and finds nothing).
This is an explicit non-goal for 0.1.0, not an oversight: core invocation and
result submission both have a non-MCP path (the CLI and the SDK), and the
Optional-adapters row closes on "no MCP adapter exists", not on "MCP support
exists". _Falsified by_ an MCP adapter appearing in `src/` without this
document being updated.

### Per-stage structural artifact schemas

Only the verdict-agreement half of the Artifact contract is closed this phase
(check 17b: an opt-in, first-line marker that must agree with the envelope's
verdict). Nothing validates the _structure_ of a review, plan or completion
artifact beyond that one optional line — a reviewer's markdown can say
anything else, in any shape, and still be accepted. Per-stage structural
schemas are a new contract surface, a new authoring burden and a new
validation area, and shipping one at 0.1.0 was out of scope for this phase.
_Falsified by_ a definition declaring a structural artifact schema that the
engine validates before acceptance.

### `/woof:run` "stop after a second rejection" (LV-002)

Prose only, not enforced in code. `plugin/claude/commands/run.md` step 4
instructs the calling agent: on an admission rejection (exit 2), fix every
named field and retry once; if the retry is rejected too, report that
rejection and stop rather than looping. This is agent behavior the command's
text asks for, not a limit the engine itself enforces — nothing in `src/`
stops a caller (or a misbehaving agent) from retrying a third time.
`test/plugin-manifests.test.ts` checks the wording is present; every live run
this phase exercised only the happy admission path (L-EXT's one rejection was
corrected and retried successfully once — the second-rejection path was never
exercised, live or otherwise). _Falsified by_ a live run reaching a second
rejection where the calling agent retries again instead of stopping.

### PR-fix-4 untested paths

Four narrow paths from carry-over C3, each needing a full-disk or two-host
harness to exercise honestly (a fake for either would only prove the fake, not
the real behavior):

- `outcome.json` failing to write because the same full disk that broke a
  claim also has no room for the host's own outcome record.
- The brief invalid-claim window between a failed pane-claim create and its
  unlink, where a second host could observe a transiently-inconsistent claim
  directory.
- Project and user workflow launches binding by run id only, with no
  additional check that a later-discovered workflow file still matches what
  admission resolved.
- A foreign journal returning `run_exists` without waiting for its host to
  finish claiming, which a slow-claiming second host could in principle race.

None of these four is exercised by this phase's tests or live runs.
_Falsified by_ a harness (full-disk or two-host) that exercises one of the
four and either confirms or contradicts the documented behavior.

### Role instruction/context files

Not implemented. A role file (`roles/<name>.json`) configures `kind`, `model`,
`args` and an optional `description` only; there is no configuration surface
for per-role instructions or context files that a workflow's `request()`
would fold in automatically. `docs/decisions/architecture.md`'s Configuration
row has named this an explicit non-goal since p4, unchanged by p5. _Falsified
by_ a shipped configuration key that lets a role file supply instructions or
context consumed by request construction.

### Live-agent-behavior observation — the checklist-injection probe (resolved)

Not a limit; recorded because it shaped a shipped fix (LV-102) and is worth
keeping visible. Verification round 1's L-BR run (`docs/research/` no longer
holds that log; its full record was in the verifier's `live/INDEX.md` §4,
which is not part of this repository) gave the reviewer
role a checklist requirement — every file under `src/` must start with an
exact `// woof-acceptance: <nonce>` line — that the input never gave the
builder or repair role directly. Review 1 correctly found the line missing
and failed, routing to repair; the builder's repair was a deliberate no-op,
reasoning in its own completion report that a requirement it only encountered
inside another agent's artifact, with no evidence of it anywhere else in the
repository, matched the pattern of a prompt injection, and declining to act on
it without independent confirmation. Review 2 re-checked, failed again on the
same missing line, and correctly noted the requirement did come from the
harness's own reviewer-role instructions — but had no channel to tell the
builder that. Two rejections at `maxRounds: 2` exhausted the run (9/13 gates).

This was classified as a live-agent-behavior finding, not a Woof engine
defect: the acceptance script's own technique (handing a requirement to the
reviewer only, expecting it to reach the builder secondhand through the review
artifact) collided with the builder's own reasonable prompt-injection caution.
It is resolved by the canonical-review sentence (LV-102, `REVIEW_IS_CANONICAL`
in both `src/workflows/build-review.ts` and `src/workflows/plan-build-review.ts`):
a repair request entered by an accepted review now states plainly that the
review is canonical for that repair, its blocking findings are project
requirements to satisfy (not suggestions), and an objection belongs in
`completion.md`, never left unaddressed. Round 2's L-BR rerun, the identical
probe against the fixed product, reached 13/13: the builder satisfied the
marker requirement and recorded an objection about its unclear origin in its
completion report — satisfy and object, not silent compliance and not refusal.

## Tabs and observability (live, outside the matrix)

This section is additional to the v1 matrix above. Its three logs are **not**
registered in `scripts/acceptance/matrix.mjs` and no matrix row cites them: the
matrix mirrors `docs/acceptance/v1.md` one row at a time, and the tab layout,
the host lifecycle records and the run index are not v1 rows. `bun run
acceptance:collect` therefore does not read these logs.

**What ran.** `node scripts/live/tabs-observability.mjs`, one part per
invocation, on 2026-09-21 on the `feat/tabs-observability` branch at `9375fcd`
(worktree clean, recorded in each log) with herdr 0.9.1, claude 2.1.278 (Claude
Code), node v26.7.0 and real Claude agents (`sonnet`) on the deterministic
build-review fixture. The logs are committed as
`docs/research/tabs-observability-live-a.log`, `…-live-b.log` and
`…-live-c.log`, redacted like the other logs (the home directory is `~`, the
session-local evidence directory is `<evidence-dir>`); every gate line, id and
timestamp is unchanged. The run directories and the per-run evidence files
(journals, tab samples) stayed on the operator's machine and are not part of
this repository.

The run happened **before** the central-index fixes that followed it on the same
branch (`run_id_ambiguous`, `runs --reindex` keeping unavailable locators,
the `--all --follow` cap and `--max-runs`, absolute locator paths). Those fixes
are covered by `test/index.cli.test.ts` only; the live script was not repeated
after them.

**Part A — hosted build-review run, one tab per participant: 17/17 gates (A1–A16,
H1).** Run `live-tabs-a-20260921-050015`: build → review fail → repair → review
pass, `run.terminated` completed (approved), `status <runId> --wait` exit 0.

- `host.claimed` is journaled with the host's pane and tab (`w9A:t3`), and both
  `agent.assigned` records carry different, non-null tab ids that are not the
  host's (builder `w9A:t4`, reviewer `w9A:t5`). `herdr tab list` showed those
  tabs (`woof:builder`, `woof:reviewer`) in all 18 samples taken while the run
  was active, each holding exactly its agent's pane; the watch pane was a split
  inside the host's tab.
- The repair reused the builder: same agent, pane, terminal and native session
  as the build, no replacement. `run show --verify-artifacts` reported no
  altered artifact (4 checked), and the fixture repository held the repaired
  change with `node --test` passing.
- The run directory was outside `~/.woof/runs`, and `woof runs` with no path
  flags listed it from the run index; `woof status <runId>` resolved it by id;
  `woof events --all` introduced the run and carried 24/24 of its events.
- `host.exited` was the last record (seq 24), after `run.terminated` (seq 23),
  written by the claiming pid. Afterwards both agent tabs were closed and the
  host tab remained.

**Part B — the host is killed mid-run: 8/8 gates (B1–B7, H1).** After a
dispatch, with `journal.lock` absent, the host pid from `host.json` was killed
with `kill -9`. `woof status <runId>` reported owner `lost` and `--wait` exited
8; `woof runs` still listed the run as `running` with owner `lost`;
`woof run cancel <runId>` appended `host.lost` → `run.cancel_requested` →
`run.terminated{cancelled}`; a late `woof submit` was rejected as `run_closed`
and accepted nothing. The killed host left one agent tab open; the script
reported it and closed it (and the host tab) with `herdr tab close`.

**Part C — event reconnect: 6/6 gates (C0–C4, H1).** A
`woof events <runId> --follow` child was killed mid-run after seq 5 and resumed
with `--after` its last cursor while two records were written in the gap. The
resumed follow started at seq 6 and ended `terminated`; across both connections
seq 1..14 had no gap and no repeated seq with different content; SDK
`foldEvents` over the collected events equalled `readSnapshot` (JSON form,
`liveness` excluded).

**Not proven by this run.**

- Crash resume: a killed host was cancelled, never resumed or re-hosted (see
  the limit above).
- Per-agent runtime lifecycle transitions (`agent.lifecycle_changed`:
  ready/working/blocked/gone) are not journaled, so nothing here observed them.
- `plan-build-review` was not re-run live on the tab layout; only `build-review`.
- A host killed mid-run leaves its agent tabs open until something closes them:
  `woof run cancel` does not, and Part B's tab was closed by the script.
- The full test suite and `bun run verify` were not run in this effort, only the
  targeted files `test/index.cli.test.ts`, `test/inspect.cli.test.ts`,
  `test/web-server.process.test.ts`, `test/acceptance-matrix.test.ts` and
  `test/acceptance-evidence.test.ts`.
- One operator machine, one Herdr version, one agent kind.

**Re-run.** Inside a Herdr pane, after `bun run build`, with the fixture
repository trusted once in Claude Code (`--probe` reports the preconditions):

```sh
node scripts/live/tabs-observability.mjs --probe
node scripts/live/tabs-observability.mjs --part A --evidence-dir <dir>/live-A
node scripts/live/tabs-observability.mjs --part B --evidence-dir <dir>/live-B
node scripts/live/tabs-observability.mjs --part C --evidence-dir <dir>/live-C
```

Each part re-initializes the shared fixture, so never run two at once. Exit 0
means every gate passed; `run.log` in the evidence directory is what was
committed here.

### Re-run on the final branch code

After the index review fixes and the module-boundary refactor, the whole script
(`--part all`) was run again live at `40788db` on 2026-09-21: **28/28 gates passed**
(log: [tabs-observability-live-final.log](../research/tabs-observability-live-final.log)).
`bun run verify` passed at the same commit (58 files, 930 tests, package smoke).

## Human-readable run output, one pane per run (feat/run-output)

Live at `31cc099` on 2026-09-22 (herdr 0.9.1, real Claude agents), the whole
`scripts/live/tabs-observability.mjs --part all` script passed **28/28 gates**
(log: [run-output-live.log](../research/run-output-live.log)). What it proves
on top of the tabs/observability run above:

- The run host renders the human run view in its own pane; the host tab holds
  exactly one pane (gate A7, no watch split) and `<run-dir>/host.log` carries
  the technical dispatch lines.
- The journal holds `agent.lifecycle_changed` and `run.activity` records
  written only on change; `woof watch` and `woof events --all` project them
  (parts A and C), and `foldEvents == readSnapshot` still holds with them.
- The killed-host and reconnect procedures (parts B and C) are unchanged.

Not proven live: a custom workflow whose completing revision differs from the
reviewed one (unit-tested only); rendering at 80 columns inside a Herdr pane
(unit-tested only); `plan-build-review` was not re-run live.
