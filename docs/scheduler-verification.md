# Native scheduler verification — 2026-10-04

Branch `claude/native-scheduler` from master `e8a5cc9` (after the Life OS
integration merge). Go 1.26.3, macOS (darwin/arm64). Linux runtime was not
exercised locally; CI runs the same checks on Linux and macOS.

## Commands

Run from the worktree root against the final branch head.

| Command | Result |
| --- | --- |
| `make check` (build, test, race, vet, lint) | Passed at `c23889a`: `go test` and `go test -race` ok for all 12 tested packages (including `internal/schedule`, `internal/tui`), vet clean, golangci-lint `0 issues` |
| `make integration` | Passed: 5 scenarios, including "scheduler reads, scope refusal, usage errors and final receipts" |
| `make install-test` | Passed: install/idempotence/opt-in skill/uninstall/conflict preservation |

## Automated evidence

| Requirement | Tests |
| --- | --- |
| Cron syntax, descriptors, `@every`, invalid input, zone prefix | `internal/schedule` `TestParse`, `TestNextSequences`, `TestNextNever`, `TestNextEvery` |
| Timezone/DST: gap fires at jump, repeated time once, Lord Howe 30-min, São Paulo midnight gap | `TestNextSequences`, `TestNextProperties`, `TestNextOracle` (independent minute scan around 8 transitions), daemon `TestScheduleTimezoneAndDSTFiring` |
| Due/not due with a fixed clock, schedule advance | `TestScheduleDueAndNotDueWithDeterministicClock` |
| Add/list/show/enable/disable/remove/manual run/history, invalid cron | `TestScheduleManualRunHistoryAndInvalidCron` (adapted donor `TestScheduleHorchAction`), `TestScheduleEnableDisableRemove` |
| Missed runs: latest, skip, grace, capped counts | `TestScheduleMissedRunsCoalesceAndPolicy`, `TestDue`, `TestDueCappedLatestMatchesEnumeration` |
| Duplicate claims: concurrent loop/claims, concurrent manual runs, replayed request ID, clock step back + re-enable | `TestScheduleConcurrentClaimsAndManualRunsDoNotDuplicate`, `TestScheduleClaimCollisionAdvancesWithoutSpinning` |
| Restart recovery from receipts (no intent → retry; sending → uncertain; landed → dispatched) | `TestScheduleRestartRecoversInterruptedAttemptFromEvidence`, `TestScheduleRecoveryClassifiesLandedDispatch` |
| Busy/offline/lost/terminal/stale identity, alias reuse never retargets | `TestScheduleBusyWorkerBlocksThenRetriesWithoutInterrupting`, `TestScheduledMessageToBusyWorkerQueuesWithoutPrompt`, `TestScheduleOfflineLostTerminalAndStaleTargets` |
| Uncertain delivery never resent; resolution reflected; settlement needs report + turn end | `TestScheduleUncertainDispatchIsNeverResent`, `TestScheduledDispatchOccurrenceFollowsSettlementAndResolution`, `TestScheduleDispatchSettlesOnlyWithReportAndTurnEnd` |
| Two-session isolation (names, explicit IDs, list/show/mutate, events) and worker-caller scope | `TestScheduleIsolationAcrossTwoSessions`, `TestScheduleWorkerCallerSeesOwnSchedulesWhileRunScoped`, store `TestScheduleScopeSelectorsIsolateSessions` |
| Existing-schema migration v1 → v2, failed migration untouched, unique keys | store `TestMigrationV1ToV2PreservesStateAndAddsSchedules`, `TestFailedScheduleMigrationLeavesVersionOneUntouched`, `TestScheduleOccurrenceKeyAndActiveNameAreUnique` |
| Loop wakes on kick | `TestSchedulerLoopWakesOnKick` |
| CLI parsing, read-only reads, receipts | `internal/cli` `TestSchedule*`, `internal/client` `TestScheduleReadsAreReadOnlyAndMutationsCarryOperationIDs`, integration "scheduler reads, scope refusal, usage errors and final receipts" |
| TUI Schedules tab | `internal/tui` `TestSchedule*`, `TestActionDaemonScheduleEnableDisableRunNow`, `TestScheduleActionUncertaintyPreservesOperationAndNeverResends` |

## Live Herdr evidence

Isolated state `/private/tmp/woof-sched-live-193704` (`WOOF_STATE_DIR`,
`WOOF_CONFIG`, binaries built from commit `4245ff5` via `git archive`), daemon
`woofd --watchdog 0`, uniquely named Herdr session `woof-sched-193704` (stopped
afterwards). Profile `demo` = `claude --model haiku`. The production daemon and
database, Life OS notes and plugin registrations were not changed; no
permission was granted to the agent. Raw JSON is kept beside the state.

1. Scheduled message `ping2` (`@every 1m`, worker
   `worker_40332cc01a102e7157235742cccf4d25`): occurrence
   `srun_20c2db0487682f63a198dccf4fb9fdcc` due 19:42:29.895+02:00 was claimed
   and its message `msg_13c96957bb8e09356772693693f7a42d` persisted in the same
   transaction; `woof wait --events schedule.run.persisted` returned it. The
   wake prompt was delivered, the turn ended, and the agent acknowledged and
   consumed it (delivery `consumed`, wake `ended`). The occurrence stayed
   `persisted`: delivery is not completion.
2. Scheduled dispatch `work` (`* * * * *`, Europe/Warsaw): occurrence
   `srun_7c8bde1ccfe6b7234d30b8386e8054a3` at 19:44:00 dispatched
   `dispatch_ca7527fb6301adf9a09b0c7f358a76a4` (attempt receipt
   `op_61bc78b5c854c1c58d8a662f0d08bf6b`). It settled only after the explicit
   report `msg_f82ba8ad211d8e1c1ef5dcb95f335f49` and turn end (working seq 21,
   end seq 22); the occurrence moved to `settled` in that transaction.
3. Busy target: the 19:45:00 occurrence `srun_673e18673c8892c7371e2e8156359111`
   was `blocked` (`worker_busy`) without a prompt while the first dispatch ran;
   the 19:46:00 due time was coalesced onto it (`skipped_count` 1). It
   dispatched 0.3 s after the first settlement (idle observation wake, attempt
   7), not by interrupting the agent. Its dispatch first showed an ended turn
   without a report and stayed active (idle alone did not settle); it settled
   after the later report (end seq 30). The 19:47:00 occurrence was `cancelled`
   when the schedule was disabled.
4. Uncertain launch handled by inspection: a worker launch into a closed Herdr
   workspace returned `uncertain` (`op_a9581d7d111416d5c6c07dcbcbbaf946`). The
   session listed no workspaces or agents; it was explicitly resolved as failed,
   not resent.

Observed limitation (pre-existing, not scheduler code): a worker started with
`--pane` into an existing pane does not receive injected `WOOF_STATE_DIR`,
`WOOF_CONFIG` or `PATH`. In the first demo attempt the agent's `woof` CLI
therefore reached the default daemon; its transcript shows only reads
(`woof inbox`, `woof workers`), refused for the unknown worker before any
receipt. Isolated live tests must spawn workers into new tabs.

## Independent review

A read-only reviewer found no duplicate-send or resend path. Confirmed medium
findings — claim collision stalling a schedule and spinning the loop, worker
callers with an inferred run unable to list their schedules, and occurrences
not following dispatch settlement/resolution — were fixed in `4245ff5` with
regression tests, together with low findings (accepted receipts, overlap rows,
backoff growth, auto-disable cancellation, actor attribution, history order,
`/etc/timezone`). REVIEW2

## Limitations

- At-most-one claim per occurrence key; delivery is not exactly-once.
- Message schedules have no backpressure: each occurrence queues one message
  for a busy or offline worker.
- Automatic launch of stopped workers, new permissions and startup dialogs are
  out of scope.
- Rolling back to an older binary after migration requires a database backup.
- Linux runtime and a live DST transition were verified only through tests.
