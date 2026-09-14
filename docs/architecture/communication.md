# Communication and artifacts

## Core contract

Agents produce artifacts for substantive work. Structured envelopes describe
the outcome and point to those artifacts. A review artifact is required and
canonical; the builder receives that artifact rather than a rewritten summary of
the findings. This follows the final correction in the
[product conversation](https://chatgpt.com/c/6aa71569-4e7c-83ed-b6d6-03992919a7c4).

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
  schema, then run identity, attempt existence, owner, duplicate/conflict,
  staleness, verdict, artifact scope, artifact existence, artifact content,
  artifact hash, and finally publish-and-record.
  `src/contracts/reasons.ts` (`REJECTION_REASONS`) is the closed set, and the
  doc comment on `submitResult` in `src/submission/submit.ts` is the
  authoritative order.
- **The journal is the sole authority.** `<runDir>/journal.jsonl` is
  append-only; attempt and acceptance state is derived by replaying it. Reads
  fail closed: a torn line, an impossible state transition, or a journal or
  lock path that turns out to be a symlink all report `journal_corrupt` or
  `journal_busy` rather than silently accepting or skipping the record.
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
- **In-process transport only.** `woof submit` opens and locks the journal
  itself, in the calling process. There is no daemon, socket, or live run
  owner to submit to; a future run owner would call the same `submitResult`
  function behind its own transport.
- **No automatic stale-lock recovery.** A lock left behind by a crashed
  writer makes every subsequent writer report `journal_busy` after the
  timeout, naming the lock file and its recorded holder, until a person
  deletes it by hand.

**Not implemented in p1:** the engine does not parse artifact-embedded
metadata or check it for agreement with the envelope's `verdict` (item 5 under
"Acceptance of a result" below); there is no bounded format-repair loop —
every rejection is journaled, but nothing retries or re-prompts the worker
automatically.

## Work request

A request identifies the run, agent, stage visit and attempt. It supplies the
structured task input, relevant project context, exact input artifact references,
expected output contract, destination for new artifacts, and the mechanism for
submitting the envelope. Work-specific permissions and limits are resolved before
dispatch, not invented by the worker.

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
