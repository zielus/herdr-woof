# Communication and artifacts

## Core contract

Agents produce artifacts for substantive work. Structured envelopes describe
the outcome and point to those artifacts. A review artifact is required and
canonical; the builder receives that artifact rather than a rewritten summary of
the findings. This follows the final correction in the
September 2026 product design conversation.

```text
caller → structured workflow input → Woof / HerdrAgentsSDK
engine → work request through Herdr → worker
worker → artifact + small result envelope → engine validation
engine → accepted artifact reference → next worker or caller
```

The SDK owns routing, validation, ownership and transitions. Herdr carries
prompts and runs agents. Agents do not coordinate workflow progression by typing
into one another's panes, and Woof does not scrape terminal prose for results.

## Implemented now (p1 prototype)

This is the first working slice of the contract above — real shipped
behavior, not design intent. The exhaustive detail lives in
`docs/decisions/architecture.md` and the source it cites.

- **Envelope v1** (`schemaVersion: 1`): `runId`, `agentId`, `stageId` (each
  matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), `visit` and `attempt` as
  safe integers `>= 1` (`Number.isSafeInteger`; not the `attemptId` string
  shown in earlier drafts of this page), `status` (`"completed"` or
  `"failed"`), a required `verdict` (a string, or `null` when the stage
  declares no verdicts), and `artifact: { path, sha256 }` — a POSIX-relative
  path with no `..` segments and a 64-character lowercase hex digest. Unknown
  top-level or artifact keys are rejected; the envelope file is capped at
  64 KiB.
- **Reason codes and decision order.** `woof submit` runs a fixed, closed set
  of checks and returns the first one that fails: run directory, journal lock
  (`journal_busy`), journal replay (`journal_corrupt`), the run being opened
  (`run_dir_invalid` if not, unjournaled), envelope readability, envelope
  schema, then run identity, **the run not yet terminated (check 7b,
  `run_closed`)**, attempt existence, owner, duplicate/conflict, staleness,
  verdict, artifact scope, artifact existence, artifact content, artifact
  size (`artifact_too_large` above 32 MiB), artifact hash, **an opt-in
  artifact/envelope verdict agreement for a stage that declares one (check
  17b, `verdict_artifact_mismatch` — p5, see "Implemented now (p5)" below)**,
  and finally publish-and-record. `run_closed` outranks an identical
  duplicate: a late resubmission of an already-accepted attempt after
  termination is rejected as `run_closed`, not returned as the prior receipt
  (lead decision) — the receipt itself stays readable in the run's snapshot.
  `src/contracts/reasons.ts` (`REJECTION_REASONS`) is the closed set, and the
  doc comment on `submitResult` in `src/submission/submit.ts` is the
  authoritative order: 18 checks plus the always-applicable lettered check 7b,
  and, only for a stage that opts in, check 17b between 17 and 18.
- **The journal is the sole authority.** `<runDir>/journal.jsonl` is
  append-only; attempt and acceptance state is derived by replaying it. Reads
  fail closed: a torn line, an impossible state transition, or a journal or
  lock path that turns out to be a symlink all report `journal_corrupt` or
  `journal_busy` rather than silently accepting or skipping the record.
- **The journal now also carries run facts, not only submissions (p2).**
  Beyond p1's `attempt.opened`/`submission.*`, the journal records
  `agent.assigned`, `request.dispatched` and `run.terminated`, and
  `run.opened` may carry an optional validated `plan`. See
  [domain model](domain-model.md#implemented-now-p2) for the full record and
  refusal table; every record type stays `schemaVersion: 1` under an
  explicit compatibility contract, and a plan-less run (p1's shape) skips
  every plan-referencing check.
- **Two read paths, two failure behaviors.** `readJournal` is the strict
  reader and does not itself acquire the journal lock; it fails closed on a
  torn final line — a p1 invariant, unchanged in p2. `submit`, `attempt
open` and the run-facts store call it from inside their own locked
  callback, so in practice it only ever reads while the lock is held; a
  direct call to `readJournal` outside a lock does not acquire one itself.
  `readJournalPrefix` (used by `readSnapshot`, `readEvents` and
  subscriptions) is a tolerant, lock-free read: every complete
  newline-terminated line gets the same validation, but a final segment
  without a trailing newline is reported as `tailPending` and excluded
  rather than treated as corruption, because a writer may still be
  appending it.
- **Documented limit: a p1 reader against a p2 journal is not tested.** The
  compatibility contract states the expected outcome — a p1 build's
  `readJournal` fails closed with `journal_corrupt` on a `run.opened.plan`
  field or on a p2-only record type, because the p1 record parser rejects
  unknown fields and types — but no test in this repository builds an old
  revision and exercises it. There is no shipped p1 consumer, and standing
  up an old checkout inside the suite was judged out of proportion (lead
  decision, repair round 1).
- **Accepted artifacts are immutable copies.** On acceptance, the worker's
  artifact is copied to `<runDir>/accepted/<stageId>/visit-<n>/attempt-<m>/`,
  re-hashed, and made read-only (mode `0444`). Downstream consumers read that
  copy; the worker's original can change afterward without affecting it.
- **Engine-owned paths are symlink-contained.** The engine-owned directories
  (`artifacts/<stage>/visit-<n>/attempt-<m>/` and
  `accepted/<stage>/visit-<n>/attempt-<m>/`, including each ancestor) and the
  `journal.jsonl` and `journal.lock` files must be real directories and files
  inside the run directory; a symlink at any of those components is refused
  rather than followed. A submitted artifact file may itself be a symlink, as
  long as its target resolves inside the attempt directory (covered by
  `test/submit.cli.test.ts`); the accepted copy is always a regular file.
- **Correlation, not authentication.** Attempt ownership is checked against
  the envelope's `agentId` and, when the attempt recorded one, the
  submitter's `HERDR_PANE_ID`. Both are self-reported by the caller's
  environment, so this is a guard against misdirected or stale submissions,
  not an authentication mechanism. A run owner issuing per-attempt tokens is
  future work.
- **A rejection carries `identity` only when it is owner-verified.**
  `submission.rejected` always records the rejection reason and message;
  `identity` (`runId, agentId, stageId, visit, attempt`), which lets it
  attach to an attempt and count as delivery evidence, is journaled only for
  a reason the check that produced it can itself verify. For `envelope_invalid`
  (a schema failure) that means the envelope's own claimed identity, kept
  only when the named attempt exists, its opened `agentId` matches, and no
  pane conflicts with the submitter's; for `envelope_malformed` (bytes that
  do not parse, or an unreadable file) it means the single open, dispatched,
  unaccepted attempt whose pane matches the submitter's `HERDR_PANE_ID` —
  with zero or several such attempts, no identity. Every other rejection
  reason keeps its existing identity behavior. **`owner_mismatch` is the one
  exception that is excluded on purpose**, even though it is
  identity-bearing: see
  [domain model](domain-model.md#implemented-now-p3) for the reconcile rule.
  Without an identity-bearing rejection, a format-repair request quotes "none
  — no submission was recorded"; with one, it quotes the rejection.
- **In-process transport only.** `woof submit` opens and locks the journal
  itself, in the calling process. There is no daemon or socket, and the run
  host (p4) is not a submission endpoint: it reads submissions from the
  journal. Another transport would call the same `submitResult` function
  behind it.
- **No automatic stale-lock recovery.** A lock left behind by a crashed
  writer makes every subsequent writer report `journal_busy` after the
  timeout, naming the lock file and its recorded holder, until a person
  deletes it by hand.

**Not implemented in p1 or p3:** the engine does not parse artifact-embedded
metadata or check it for agreement with the envelope's `verdict` (item 5 under
"Acceptance of a result" below); the envelope stays v1, unchanged. **This is
now implemented, opt-in, as of p5** — see "Implemented now (p5)" below.

**Format repair is implemented (p3).** See
[domain model](domain-model.md#implemented-now-p3) for the full rule (D5): when
an agent settles `ready` after a started dispatch with no accepted submission
for the attempt, the scheduler opens a new attempt in the same visit and sends
a format-repair request naming the journaled rejections (or "no submission was
recorded"). It is bounded by its own limit, `maxFormatRepairs` (per visit,
distinct from `maxAttemptsPerVisit`), and never resends into the old attempt —
p2's one-dispatch-per-attempt invariant (`dispatch_exists`) is unchanged.

## Work request

A request identifies the run, agent, stage visit and attempt. It supplies the
structured task input, relevant project context, exact input artifact references,
expected output contract, destination for new artifacts, and the mechanism for
submitting the envelope. Work-specific permissions and limits are resolved before
dispatch, not invented by the worker.

### Implemented now (p3)

Real shipped behavior for the rendered work request — not design intent.
Source: `src/scheduler/request.ts`.

- **`renderRequest`** produces deterministic Markdown (`# Woof work request
v1`) for one attempt: run/workflow/agent/role identity; stage, visit,
  attempt, cause (`initial | format repair | work retry`) and round; the
  repository path and the exact revision (`tree`/`HEAD`) the request was sent
  against; the goal, task (title, description, acceptance criteria, optional
  JSON context) and optional per-role project instructions; an "Inputs" section
  listing each input's absolute path plus, for an accepted artifact, its stage
  (and child stage, for a copied child artifact), visit, attempt, receipt id and
  sha256 (or, for a run input artifact or check evidence, its sha256);
  the artifact destination and size cap (32 MiB); and the exact `woof submit`
  command line, shell-quoted. A format-repair request replaces the goal/task
  with the previous attempt's journaled rejections (or "none — no submission
  was recorded") and keeps everything else. The driver persists the rendered
  text to `requests/<stageId>/visit-<n>/attempt-<m>/request.md` (mode `0444`),
  records its path/sha256/bytes on `request.dispatched.request`, and delivers
  the identical text. Every rendered request is capped at 32 KiB
  (`request_too_large` at dispatch time otherwise). The built-in
  `build-review` workflow also enforces this at admission, before a run
  opens: beyond the 24 KiB compact-JSON cap on `task`/`instructions`, it
  renders (with the real `renderRequest` and its own `request()` functions)
  the largest request the given input could produce — the review, and the
  repair entered by either the review or the verify check, each with every
  input it names, at the admitted maximum run-directory length and maximal
  counters/ids/digests — and rejects the input if that render would exceed
  32 KiB, so a compact-JSON `task.context` that expands large once
  pretty-printed into a request is caught before any agent starts.
- **Revision binding is engine-owned, not carried in the envelope.** The
  scheduler computes and journals the repository revision at dispatch
  (`request.dispatched.revision`) and again immediately before recording a
  revision-bound gate (`gate.recorded.revision`, with `reviewed` naming the
  revision the accepted attempt was dispatched against); a worker never states
  or is trusted to state which revision it reviewed. See
  [domain model](domain-model.md#implemented-now-p3) (D4).

## Review output example

Illustrative envelope; field names and paths are not a published API:

```json
{
  "schemaVersion": 1,
  "runId": "run-123",
  "agentId": "reviewer",
  "stageId": "review",
  "visit": 1,
  "attempt": 4,
  "status": "completed",
  "verdict": "fail",
  "artifact": {
    "path": "artifacts/review/visit-1/attempt-4/review.md",
    "sha256": "<64 lowercase hex characters>"
  }
}
```

The path is relative to an engine-resolved run directory. `status` describes the
work request; `verdict` drives this workflow's review gate. The artifact contains
the reviewed revision or change set, summary, findings, severity, file/line
references, and recommendations. A passing review still produces an artifact
recording its scope and outcome.

Machine-required artifact metadata, such as identity and verdict, should have a
declared parseable representation. If verdict appears in both artifact metadata
and envelope, validation must require agreement. Markdown body quality is not
proved by schema validation: acceptance must inspect the substantive review too.

Planner and researcher stages produce `plan.md` and `research.md`. A builder's
main output is the repository change, accompanied by a small completion artifact
that identifies the change and verification evidence. A claim that tests passed
is not equivalent to recorded test evidence or an independent verification stage.

## Implemented now (p5)

Real shipped behavior for the optional artifact/envelope verdict agreement
(D5) — not design intent. Source: `src/submission/submit.ts`,
`src/scheduler/definition.ts`, `src/contracts/envelope.ts`.

- **Check 17b, opt-in per stage.** An `AgentStage` with verdicts may declare
  `artifactVerdictMarker: string` (at most 64 characters). When it does, `woof
submit` runs one additional check, positioned after check 17 (artifact hash
  agreement) and before check 18 (publish-and-record) — a submission whose
  bytes do not match its own digest is reported as the hash mismatch it is,
  never as a marker disagreement. The check reads the artifact's **first
  non-blank line only**: when that line starts with the declared marker, the
  remainder, **trimmed** (surrounding spaces and a trailing CR from a CRLF
  line ending are ignored), must equal the envelope's `verdict`, or the
  submission is rejected `verdict_artifact_mismatch`, naming the artifact's
  verdict and the envelope's. A stage that declares no marker checks nothing (unchanged p1
  behavior); an artifact whose first non-blank line does not start with the
  marker is accepted unchanged; a marker-looking line further down the
  artifact is ignored, on purpose — a reviewer quoting the required line
  inside an example writes it at the start of a line too, and scanning the
  whole artifact would reject that quotation as a second, disagreeing marker.
  A leading UTF-8 BOM on that first line is stripped before the prefix test;
  leading spaces are not stripped, because the contract is that the line
  _starts with_ the marker, not that it contains one.
- **Additive at `schemaVersion: 1`.** The declared marker is journaled as an
  optional field on the `attempt.opened` record (see
  [domain model](domain-model.md#implemented-now-p5)); a journal with no such
  field (every p1–p4 fixture) still replays clean.
- **Both built-in `review` stages opt in.** `build-review` and
  `plan-build-review` both declare `artifactVerdictMarker: "Woof-Verdict:"`
  and ask the reviewer, in the request text, to make it the artifact's first
  line, agreeing with the verdict in the envelope.

## Acceptance of a result

Before advancing, the engine must verify all of the following:

1. The submission belongs to the currently open attempt and assigned agent.
2. The envelope matches the stage's declared schema and allowed outcomes.
3. Required artifacts exist, are readable and complete, and satisfy their
   declared structural contract.
4. References resolve within the allowed output locations and identify the
   correct visit; stale artifacts cannot satisfy new work.
5. The artifact and control data agree. The accepted artifact version remains
   stable for downstream consumers.

The first accepted submission closes the attempt. Persist acceptance before
acknowledging it. Retry of the same submission must return the same receipt;
conflicting or late submissions must not advance the workflow.

Use unique output locations per visit/attempt and a completion boundary that
prevents partially written files from being accepted. Atomic publication plus
explicit submission is one implementation candidate. Retain accepted versions
instead of overwriting a single `review.md` every round.

## Invalid output and delivery uncertainty

Return concrete validation errors to the same agent and allow a bounded format
repair. Correcting metadata or a malformed envelope is separate from rebuilding
the feature or conducting another substantive review. Missing substantive work
may require a new work attempt under the workflow policy. Exhaustion produces an
explicit reason and retains the rejected-output diagnostics.

Herdr documents lifecycle waits separately from output collection. A stalled or
timed-out prompt may already have been delivered, and `unknown` does not establish
completion. Woof therefore correlates explicit results with attempts and avoids
blind resends. [Herdr agent automation](https://herdr.dev/docs/agent-automation/).

p2 records this certainty directly: `request.dispatched.delivery` is
`started | not_delivered | ambiguous`, each with its own closed `reason` set
(`DISPATCH_REASONS` in `src/domain/types.ts`), so a timeout can never be
recorded as provably not delivered. Only `not_found` and `runtime_unavailable`
end the run `failed`; every other `not_delivered` reason — `agent_busy`,
`agent_blocked`, `invalid_request`, and `precondition_failed` (a failed
precondition read, or the delivery deadline expiring before the prompt could
be sent) — is retried as a new `work_retry` attempt, bounded by
`maxAttemptsPerVisit`. See
[domain model](domain-model.md#implemented-now-p2) for the full reason set
and its behavior. At most one dispatch is recorded per
attempt (`dispatch_exists`); there is no resend, so trying again is only
expressible as a new, explicitly opened attempt. An `ambiguous` dispatch
whose attempt is still open surfaces in
`snapshot.attention.ambiguousDeliveries` until the attempt is accepted or
superseded. **Reconciliation is implemented (p3, D8):** after an `ambiguous`
dispatch the scheduler sends nothing further to that agent and waits for
evidence — a `submission.accepted`/identity-bearing `submission.rejected` for
the attempt (an `owner_mismatch` rejection never counts as this evidence,
however identity-bearing it is — a foreign submitter is not proof the
addressed agent received anything), or a tracked observation of the same
terminal taken after the
dispatch showing `working`/`blocked` — either of which records
`delivery.reconciled{resolution:"delivered"}` and the attempt continues as if
started; with neither before `deliveryTimeoutMs` elapses, it records
`delivery.reconciled{resolution:"abandoned",
evidence:"no_evidence_before_deadline"}` and the run ends
`exhausted{limit:"deliveryTimeoutMs"}`. `not_delivered` stays in the domain
type but no p3 record can carry it as a reconciliation resolution: no evidence
proves a prompt was never delivered after an ambiguous dispatch. Reconciliation
never resends the prompt.

## Transport choice

The mandatory contract is artifact production plus validated, correlated
submission. MCP is optional. A worker-callable CLI that submits a small envelope
to the run owner is a recommended first prototype; the SDK exposes the same
operation directly. A completion-file protocol is another option if atomicity,
acknowledgement, bounded waiting, and duplicate handling are specified.

An MCP tool may wrap this operation later. It must not be the only path through
which a worker can complete a stage. The stashed draft's MCP-only `woof_submit`
proposal is superseded on this point. Exact transport and publication mechanics
remain an implementation decision to prove with the acceptance scenarios.
