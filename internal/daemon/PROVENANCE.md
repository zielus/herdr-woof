# Runtime provenance

Adapted from the MIT-licensed `herdr-orch` reference; complete notice is in
[`../../THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

| Woof component | Inspected/adapted donor | Boundary changed |
| --- | --- | --- |
| `server.go`, `sessions.go`, `core.go` | `internal/daemon/server.go`, `engine.go`, `internal/client/client.go` | Global ownership, independent multi-session subscriptions, logical worker and attachment IDs. |
| `dispatch.go`, `messaging.go`, `watchdog.go`, `mutations.go` | `internal/daemon/engine.go`, `ops.go` | Durable per-recipient attempts; original-turn evidence; explicit mutation receipts; no automatic mutation replay. |
| `workers.go`, `attachment.go`, `birth_*.go` | `internal/daemon/workers.go` | Existing/shared worktrees, process-birth checks, fenced recovery and verified cleanup. |
| `events.go`, `hub.go` | Generic event fan-out/replay ideas in `internal/daemon/plans.go` | Retain cursor replay and slow-reader recovery; omit plans, schedules and workflow machinery. |

Donor edge cases are adapted into `coordination_test.go`, `workers_test.go` and
`hub_test.go`. In particular, Orch's `TestDispatchSettlesOnDonePlusIdle` and
`TestIdleBeforeWorkingDoesNotSettle` inform the report/turn-end ordering tests;
`TestIdleWithoutReportEscalatesNeverFails` informs persistent escalation tests;
`TestReleaseVerifiesProcessesGone`, `TestReleaseKillsStragglers`,
`TestReleaseRefusesBusyWorker` and `TestReleaseRefusesDirtyWorktree` inform protected
release and birth-checked cleanup. `TestPlanHubSlowSubscriberDoesNotBlockOthers`
is adapted in `hub_test.go`.

Other session, attachment, mailbox, crash-boundary and review regression tests are
Woof-specific additions. They deliberately reject donor assumptions about
per-session database ownership, pane-keyed identity and idle-only settlement.
