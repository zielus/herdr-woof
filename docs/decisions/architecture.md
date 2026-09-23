# Architecture decisions

This page is the concise entry point for Woof's architecture. The linked
reference pages describe the current contracts in detail. The acceptance evidence
records results from the revisions named in that file; it is not fresh 0.3.x
acceptance.

## Settled product direction

### Product and ownership

- Woof is one product across the SDK, CLI, Herdr plugin, Claude Code plugin and
  Web UI. `HerdrAgentsSDK` owns workflow coordination independently of those
  presentation layers.
- Herdr owns agent execution, panes, sessions, workspaces and worktrees. Woof
  uses those operations through a runtime adapter instead of recreating them.
- The engine and configuration layers do not import plugin UI code. MCP remains
  optional and is not a workflow admission or result-submission dependency.

### Execution and artifacts

- Role, agent kind, model, named agent and workflow stage are distinct. A repair
  stage can reuse its builder without treating the stage as a new identity.
- Substantive work belongs in artifacts. Small validated envelopes carry status,
  verdicts and artifact references; a review artifact is required and canonical.
- The engine validates ownership, correlation, completeness and freshness before
  advancing. Runtime idle state and a natural-language completion claim are not
  proof of stage success.
- Work retries, format repair, rounds, waits and delivery reconciliation are
  bounded. Ambiguous delivery is reconciled rather than blindly repeated.

### State, configuration and interfaces

- The append-only journal is authoritative for durable run facts. Snapshots and
  events are engine-owned projections consumed by every interface.
- Project configuration overrides user defaults, with built-ins below both.
  Resolution provenance is recorded once for the run and remains stable.
- The CLI and SDK remain useful without a plugin UI. The Web UI is a consumer of
  the same observation and cancellation contracts, not a second engine.

See [Domain model](../architecture/domain-model.md),
[Communication and artifacts](../architecture/communication.md),
[Configuration](../architecture/configuration.md),
[Observability](../architecture/observability.md) and
[Web UI](../architecture/web-ui.md).

## Implemented decisions

### Result submission and artifact handoff

Workers publish artifacts and submit a correlated envelope through the CLI/SDK
path. Accepted copies, duplicate handling, revision binding and optional verdict
agreement are defined in
[Communication and artifacts](../architecture/communication.md).

### Run hosting and scheduling

A hosted run has one heartbeat-tracked scheduler process in a Herdr pane, giving
the run a visible owner that can outlive its caller. The layout is one Herdr tab
per participant: the host in the root pane of its own tab, where it prints the
human view of its own run (the technical log goes to `<run-dir>/host.log`),
and every agent in its own tab, never a pane split (with a new worktree
checkout, the default inside Herdr, the host runs in the root pane of the run's
worktree workspace instead); the tab ids are journaled with `host.claimed` and `agent.assigned`. The scheduler uses the same
derived snapshot an observer reads, performs one bounded action at a time and
records control decisions before exposing them. Foreground runs remain available.
See [Domain model](../architecture/domain-model.md) and
[Observability](../architecture/observability.md).

### Workflow definitions and reuse

Workflow definitions are validated TypeScript or JavaScript modules with static
edges. `build-review`, `plan-build-review`, `plan`, `auto-build` and discovered
project/user workflows use the same admission and scheduling path. A workflow can
be a step of another, run as a child run in the parent's checkout. See
[Authoring a workflow](../workflows/authoring.md) and
[Initial workflows](../workflows/initial-workflows.md).

### Configuration

`.woof/` and `~/.woof/` JSON files and workflow modules resolve with visible
project, user and built-in provenance. Role files configure `kind`, `model`,
`args` and an optional `description`; automatic role instruction or context-file
injection is not implemented. See
[Configuration and project context](../architecture/configuration.md).

### Runtime observation

The supported production adapter uses bounded Herdr CLI calls. Runtime samples
are a freshness-stamped, in-memory overlay rather than journal facts. See
[Observability](../architecture/observability.md).

## Rejected directions

- Splitting orchestration into a separate Horde product was rejected. Woof is
  one product, and `HerdrAgentsSDK` owns the workflow loops.
- Making the review file optional in favor of a rich JSON response was rejected.
  The review artifact is canonical; JSON is the small control envelope.
- An MCP-only worker result channel was rejected. Submission must retain a
  validated non-MCP path so the SDK is transport-independent.
- Rejecting artifact or completion-file protocols outright was rejected. Required
  artifacts need explicit publication, acknowledgement, duplicate handling and
  finite waiting.
- Automatic permission bypass and a fixed Claude-only rollout were rejected as
  product requirements. Permission policy and agent-kind support remain explicit
  operator and capability choices.
- A fixed multi-package layout, YAML workflow syntax and a fluent workflow API
  were rejected as premature public contracts. Current consumers do not justify
  the package split, and examples do not settle an authoring syntax.
- A `group_by = "worktree"` sidebar setting was rejected because Herdr documents
  row layout and styling, not collapsible worktree groups. Structural grouping
  belongs in Herdr or a supported navigation plugin.
- Treating the plugin checkout or caller's working directory as a managed run's
  workspace was rejected. Workspace projection must use verified runtime context.

## Open implementation decisions

### Persistence and recovery

Run history and artifacts remain inspectable, and lost ownership is reported,
but crash resume and re-hosting are not implemented. Herdr restoring an agent
session does not restore Woof's scheduling decisions. A recovery contract and
tests must prevent duplicate effects before either is promised.

### Artifact structure and retention

Accepted artifacts are hashed and can opt into first-line verdict agreement.
Per-stage structural artifact schemas and an artifact-retention policy remain
open contract choices.

### Runtime breadth and concurrency

Only the `claude` agent kind is admitted by the built-in launch mapping. The
Herdr CLI adapter is the default runtime; `--runtime-module` is an unstable
extension point. Scheduling is sequential. A second built-in kind, stable runtime
adapter and parallel workflows need their own capability, ordering and acceptance
evidence. Stress coverage for more than two concurrent hosted runs remains open.

### Package layout

The SDK, CLI and integrations currently ship from one package with explicit
module boundaries. The boundary test enforces each area's allowed import
directions and keeps `cli.ts` unreachable from package entry points and imported
by nothing. A workspace/package split is deferred until another real consumer
demonstrates the need.

### Configuration extensions

Per-role instruction/context files, a separate per-attempt result-wait setting
and Woof-specific revision-ignore globs are not implemented. The existing
run-wide timeout and Git ignore rules remain the current bounds.

### Herdr display metadata

Separate kind, model and stage tokens, explicit checkout identity and
workspace-level projection are not implemented. Their remaining scope is in
[Open proposals](../design/proposals.md).

## Known limits

These are limits confirmed directly in the current code. Changing one would
alter a public contract, trust boundary or execution model.

- Workflow modules, `--runtime-module` and role `args` execute or pass through
  with the operator's privileges. Permission-bypass arguments are allowed with a
  warning; Woof never adds one. Direction: a real sandbox or lower-trust mode,
  plus an operator-approved allow/deny list for role arguments.
- Workflow workers receive `--add-dir <runDir>` and can therefore read or edit
  their run journal and accepted artifacts. Integrity checks detect changes but
  do not create a same-user security boundary. Direction: narrow the added
  directory or verify artifacts out of process.
- A `CheckStage` runs without a sandbox in the repository the builder edited.
  Direction: run verification in a copy or container.
- Run-directory creation does not provide a dirfd-based, whole-path trust
  boundary. Configuration hashing follows symlinks by design. Direction: use a
  dirfd-based walk if the remaining race is shown to be exploitable.
- Four paths start a run: `woof run start`, `woof run build-review`, the Herdr
  plugin's `start` action and `/woof:run`. Direction: consolidate the verbs once
  usage patterns are clear.
- `journal_write_failed` covers both run-directory creation failures and journal
  lock-acquisition I/O errors. Direction: split the reason if a consumer needs
  the distinction.
- A crashed writer can leave `journal.lock`; Woof does not remove stale locks.
  Lock release checks a token before unlinking, leaving a narrow
  compare-then-unlink race if the process is killed in that window. Direction:
  use a system lock or re-read before unlinking.
- Journal reads load the complete journal into memory, and Herdr command capture
  has no output-size cap. Check output keeps a 1 MiB tail, but its generated
  header is added outside that budget. Direction: add configurable journal and
  capture caps, and reserve header bytes in the check-output budget.
- Configuration discovery treats any failed `git rev-parse --show-toplevel` as
  "not a work tree" rather than distinguishing every Git failure mode. Direction:
  distinguish failures if Git-version behavior can be handled safely.
- Revision fingerprinting treats a failed `git rev-parse HEAD` as "no HEAD yet".
  Direction: add version-checked exit-code handling if a real repository hits
  the ambiguity.
- The run host closes the agent tabs it opened when the run ends. A host that is
  killed leaves them open: `host.lost` and `woof run cancel` close nothing, and
  no record says a tab was closed. Direction: let cancel (or a later host) close
  the journaled tabs of a lost host once Herdr ownership of them can be checked.
- Per-agent runtime lifecycle transitions (`agent.lifecycle_changed`) and engine
  activities (`run.activity`) are journaled best effort: an append the store
  refuses or cannot complete is only a warning, so their history can miss a
  transition.
- The run index (`~/.woof/index`) is a per-user set of locators, never state. A
  run id is unique only by convention: an id that the index and `<runs-dir>/<id>`
  resolve to different runs is rejected as `run_id_ambiguous`, but the CLI does
  not read every journal to find a same-id run in a differently named directory
  (`woof runs` and the Web API do). A locator whose directory cannot be reached
  is kept until `woof runs --reindex --prune`. Registration of a locator is a
  read-then-rename, not an exclusive create, so two runs with the same id opened
  at the same instant can still race for it.
- `woof events|watch --all --follow` polls each followed run separately and caps
  them (`--max-runs`, default 64); runs over the cap are named and wait for a
  free follower. There is no cross-run cursor and no `GET /api/events` for all
  runs.
- The Web UI cannot start, retry, answer a blocked agent, resume or re-host a
  run. Unsupported actions return explicit errors; cancellation is the only
  mutating UI action. Direction: add controls only after the engine exposes the
  corresponding safe operations.

The [v1 acceptance evidence](../acceptance/v1-evidence.md#pr-fix-4-untested-paths)
also records four narrow full-disk or two-host cases that were historically
unverified. This documentation pass did not rerun them and does not claim that
their behavior has been confirmed for 0.3.1.
