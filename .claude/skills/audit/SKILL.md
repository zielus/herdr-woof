---
name: audit
description: Run a full, read-only, multi-lane repository audit of herdr-woof (correctness, security, test realism, docs-vs-reality, packaging, product/UX) and disposition the findings. Use when the operator wants a pre-release or periodic audit of the whole repository.
user-invocable: true
---

# Repository audit

This skill runs the same kind of full-repository, read-only audit that shaped
phase 6 (public readiness) and phase 7 (release ops). It has two parts: the
audit prompt (dispatch to a capable model with subagents and tool access) and
the lead-disposition template (how the operator or lead turns findings into
work).

## Audit prompt template

Fill in the placeholders before dispatching. Do not paste an absolute home
path anywhere in the filled-in prompt — `bun run release:preflight`'s
`private-strings` check fails on macOS home paths, Linux home paths and
similar patterns (see `scripts/release/lib/patterns.ts`), and a prompt
containing one would itself fail preflight if it ever landed in a committed
file.

Placeholders:

- `{{REPO_NAME}}` — e.g. `herdr-woof` (Woof)
- `{{SHA}}` — the commit the audit runs against (short or full)
- `{{VERSION}}` — the version in `package.json` at that commit
- `{{REPORT_PATH}}` — where to write the report, relative to the audit run's
  own working directory (never an absolute home path)
- `{{FALLBACK_PATH}}` — a fallback path if `{{REPORT_PATH}}`'s directory is
  not writable (for example `/tmp/{{REPO_NAME}}-audit-1.md`)

```text
You are an independent auditor for the repository in your working directory
({{REPO_NAME}}, master at {{SHA}}, version {{VERSION}}). Your job is a full,
read-only repository audit. Do not modify, create or delete any file inside
the repository worktree; do not run git commands that change state (no
commit, checkout, reset, stash, branch, push). Running the read-only tooling
is fine: `bun install --frozen-lockfile`, `bun run verify`, `bun run build`,
`node --test`, `bin/woof --help`, `bin/woof doctor --json`,
`npm pack --dry-run`, git log/grep/blame.

Use subagents. Split the audit into parallel lanes and spawn one subagent per
lane, then merge their findings yourself and re-verify anything a subagent
claims that you can check cheaply. Suggested lanes: (1) correctness and
contract honesty of src/ (journal, submission checks, scheduler, limits,
revision binding, admission; fake-success paths; error reasons that lie);
(2) security (path traversal, symlink escapes, TOCTOU on the journal and
artifacts, input size caps, child-process argument handling, anything that
reads `~/.claude.json` or `~/.woof`, permission-bypass flags, secrets in tree
or history); (3) test realism (transformed-import shortcuts, tests that
cannot fail, flaky timing, coverage gaps vs the acceptance matrix in
`docs/acceptance/v1.md` and `v1-evidence.md`); (4) docs vs reality (README,
docs/, CHANGELOG, plugin SKILL and command text, `herdr-plugin.toml`: every
claimed behaviour must exist; every "implemented now" and "out of scope" line
must be true); (5) packaging and public-readiness (package.json, exports,
bin, files, engines, CI workflow, license and metadata, what `npm pack`
would ship, dependency hygiene, anything a first public reader or a first
npm installer would trip on); (6) product and UX — where using {{REPO_NAME}}
through Herdr and Claude Code would feel rough, confusing or brittle, and
concrete improvements.

Read AGENTS.md, docs/README.md, docs/product/brief.md and
docs/decisions/architecture.md first so your lanes judge against the
project's own stated boundaries.

Write the complete report to {{REPORT_PATH}} using a shell heredoc (if that
directory is not writable, write to {{FALLBACK_PATH}} instead and say so).
Report format: first line `verdict: sound|concerns|unsound` for the
repository as a whole, then the audited SHA and the commands you ran with
exit statuses, then findings ordered by severity, each with: id, lane,
severity (critical|major|minor|nit|idea), file:line, what is wrong, a
concrete failure scenario or reproduction, suggested fix, and whether you
verified it yourself or a subagent reported it. Then a section "Ideas" for
product/UX improvements, a section "What was not audited", and a section
listing each subagent and what it covered. When the file is written, reply
with exactly one line: the file path.
```

## Report format (for reference when reading a filled-in report)

- Line 1: `verdict: sound|concerns|unsound`.
- The audited SHA and every command run, with exit status.
- Findings, most severe first, each with: `id`, `lane`, `severity`
  (critical|major|minor|nit|idea), `file:line`, what is wrong, a concrete
  failure scenario or reproduction, a suggested fix, and whether the auditor
  verified it directly or a subagent reported it.
- `Ideas` — product/UX improvements, not defects.
- `What was not audited`.
- `Subagents` — each one and what lane it covered.

## Lead-disposition template

After the report lands, sort every finding into one of four buckets before
any repair work starts. Mark each row `operator` when only the operator can
decide it (product direction, scope, timing).

- **A. Already closed** — the audit is stale here; the code has already
  moved past the finding. Name the commit that closed it and the evidence you
  re-checked (do not take the audit's own evidence at face value; re-read the
  cited file/line yourself).
- **B. Docs truthfulness** — the code is fine; a doc, README section, SKILL,
  or CHANGELOG line is stale or wrong. List the exact file:line and the
  correction.
- **C. Code — small vs. design-level.**
  - *Small*: a real-process test can pin the current (wrong) behavior
    failing, then the fix makes it pass, in a bounded diff. List these as
    candidates for the next small release.
  - *Design-level*: fixing it changes a public contract, a trust boundary, or
    a documented non-goal. Do not fix these opportunistically — document them
    (bucket B, or a "Known limits" table) and let the operator decide when
    and whether to schedule the redesign.
- **D. Recommendation** — one paragraph: is the repository sound to ship (or
  keep public) as-is, with the remaining items documented rather than fixed?
  Name anything that would change that answer. Every operator decision
  (scope, timing, what ships now vs. later) is marked `operator` in the
  bucket lists above, not decided by the lead.

Cross-check any finding that would block a decision against the actual tree
before accepting it — an audit subagent's claim is a lead to verify, not a
fact to act on directly.
