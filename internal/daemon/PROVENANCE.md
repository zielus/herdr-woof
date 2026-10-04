# Runtime provenance

Adapted from the MIT-licensed `herdr-orch` reference; the cron parser derives
from MIT-licensed robfig/cron v3.0.1 as used by herdr-orch. Complete notices are
in [`../../THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

| Woof component | Inspected/adapted donor | Boundary changed |
| --- | --- | --- |
| `server.go`, `sessions.go`, `core.go` | `internal/daemon/server.go`, `engine.go`, `internal/client/client.go` | Global ownership, independent multi-session subscriptions, logical worker and attachment IDs. |
| `dispatch.go`, `messaging.go`, `watchdog.go`, `mutations.go` | `internal/daemon/engine.go`, `ops.go` | Durable per-recipient attempts; original-turn evidence; explicit mutation receipts; no automatic mutation replay. |
| `workers.go`, `attachment.go`, `birth_*.go` | `internal/daemon/workers.go` | Existing/shared worktrees, process-birth checks, fenced recovery and verified cleanup. |
| `events.go`, `hub.go` | Generic event fan-out/replay ideas in `internal/daemon/plans.go` | Retain cursor replay and slow-reader recovery; omit plans and workflow machinery. Schedules are adapted separately in `schedule.go`. |
| `schedule.go` | `internal/daemon/schedule.go`, `internal/store/schedules.go`, the `server.go` schedule loop, the `cmd/horch` schedule CLI | Durable Woof message or tracked dispatch actions replace `agent.prompt` and child-CLI actions; stable worker-ID targets; claim, history row and schedule advance in one transaction; per-attempt operation receipts; evidence-based restart recovery; timer/event-driven loop instead of a 15 s poll. |
| `../schedule/` | robfig/cron v3.0.1 `parser.go`, `spec.go` via herdr-orch `cron.ParseStandard` | Five standard fields only, stricter token checks, DST-aware civil-time `Next`, anchored `@every`, fixes the `TZ=` prefix panic; never-firing specs are refused instead of looping. |

Donor edge cases are adapted into `coordination_test.go`, `workers_test.go`,
`hub_test.go` and `schedule_test.go`. In particular, Orch's `TestDispatchSettlesOnDonePlusIdle` and
`TestIdleBeforeWorkingDoesNotSettle` inform the report/turn-end ordering tests;
`TestIdleWithoutReportEscalatesNeverFails` informs persistent escalation tests;
`TestReleaseVerifiesProcessesGone`, `TestReleaseKillsStragglers`,
`TestReleaseRefusesBusyWorker` and `TestReleaseRefusesDirtyWorktree` inform protected
release and birth-checked cleanup. `TestPlanHubSlowSubscriberDoesNotBlockOthers`
is adapted in `hub_test.go`. `TestScheduleHorchAction` is adapted as
`TestScheduleManualRunHistoryAndInvalidCron`, using a Woof message action instead
of a child process.

Other session, attachment, mailbox, crash-boundary and review regression tests are
Woof-specific additions. They deliberately reject donor assumptions about
per-session database ownership, pane-keyed identity and idle-only settlement.
