# Phase 1 verification

This record covers Woof-specific verification on 2026-10-03. The approved donor
map and architecture decisions are in [implementation-plan.md](implementation-plan.md).
Phase 1.5 UI and Phase 2 workflow execution remain deferred.

## Environment and commands

Validation runs from `/Users/zielu/Projects/herdr-woof-v2` with Go 1.26.3 on
macOS arm64, Herdr 0.9.3 / protocol 22, and authenticated Claude Code 2.1.288. All runtime
state used for tests is isolated with `WOOF_STATE_DIR` and `WOOF_CONFIG`; no tests
open or modify the user's default Woof database.

Final results against the frozen, reviewed source:

| Command | Evidence |
| --- | --- |
| `make check` | Passed: both binaries, all Go tests, all-package race detection and vet. Daemon tests: 7.625 s; daemon race tests: 15.425 s. |
| `make integration` | Passed: actual CLI binaries and isolated daemon; all scenarios below. |
| `make install-test` | Passed: temporary binary/skill installation, idempotence, opt-in skill, guarded uninstall and conflict preservation. |
| `GOOS=linux GOARCH=amd64 go build ./cmd/woof ./cmd/woofd` | Passed on the final source. Linux runtime was not tested. |
| `gofmt -l cmd internal` and `git diff --check` | Passed: no output. |

The combined command was `make check integration install-test` (exit 0). Its raw
output is retained at `/private/tmp/woof-p1-live-01a0ff95/final-check.log`.

The integration script verifies concurrent bootstrap, refusal of a second writer,
metadata-only profiles, durable gates, replay/follow/wait, human ask/reply,
acknowledgment/consumption, missing artifacts, and draining restart while a follower
remains active. It creates and removes only its temporary runtime directory.

Three fresh, fail-fast runs of `bash scripts/integration.sh` passed after the
ownership/restart fixes. Final all-target verification also includes the later
native-recovery callback regression.

Actual Herdr plugin registration/startup was tested with a separate registry:
`XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `HERDR_CONFIG_PATH` pointed inside
`/private/tmp/woof-plugin-live.towBX6`; `WOOF_STATE_DIR` and `WOOF_CONFIG` selected
its own Woof state. `herdr plugin link "$PWD" --enabled` accepted the manifest.
The headless session `woof-p1-plugin-01a0ff95` ran the exact startup argv
`["./bin/woof", "session", "attach"]`, exited 0 in about 518 ms and registered
online with protocol 22. One daemon PID 73386 owned that isolated database.
Its plugin/server/status JSON and logs are retained in the temporary directory.
The session, daemon and isolated registry entry were cleaned; both sockets were
gone. No default registry hash baseline was taken, and none is claimed.

## Automated acceptance evidence

These named tests are part of the final all-package test and race commands.

| Contract | Woof-specific tests |
| --- | --- |
| Global ownership, bootstrap, restart | `TestOwnershipLockPrecedesDatabaseOpen`, `TestDetachedBootstrapDiscoverySerializesClients`, `TestGlobalDaemonRestartPreservesReceiptAndSocket`, `TestEnsureDaemonWaitsForReleasedOwnerAndSpawnsOnlyOnce`, `TestDaemonRestartReusesConcurrentHealthyReplacement` |
| Multiple sessions, identical pane IDs, isolated outages | `TestSessionsSamePaneIDsRouteIndependentlyAndOutageIsolated`, `TestSessionStartupReconnectsPersistedRegistry`, `TestSessionSocketAliasesDeduplicateOnlineAndOffline` |
| Scoped persistence and append-only replay | `TestMigrationReopenPreservesRecordsAndReplay`, `TestRecordAndEventsCommitOrRollbackTogether`, `TestScopeFilteringAcrossHierarchyAndGlobalOverride`, `TestAppendOnlyEventsRejectUpdateDeleteAndReplace`, `TestExplicitEventSequencesCannotRegress`, `TestFailedMigrationLeavesExistingDatabaseUntouched` |
| Thin profiles and raw arguments | `TestRawArgsDefaultAndIndependentSnapshots`, `TestRejectMalformedUnknownAndInvalidProfiles`, `TestSpawnPersistsIntentBeforeTabAndKeepsRawProfileArgs`, `TestAgentLaunchExplicitSocketAndRawArguments` |
| Logical identity, adoption and pane moves | `TestSessionMovedPanePreservesWorkerIdentityAndAttachment`, `TestSessionRecoveryRejectsReusedPaneIdentity`, `TestAdoptionRequiresIncarnationEvidenceAndFencesOldDispatch`, `TestSessionReadoptionCannotReuseOldAttachmentBarrier`, `TestWorkerScopeFollowsMovedPaneWhileDispatchKeepsOriginalWorkspace`, `TestSessionMoveAliasCollisionRenamesOnlyMovedWorker` |
| Caller identity despite reused current/historical pane references | `TestOverlappingCurrentPaneAndAliasRouteOwnProcessLineage`, `TestOverlappingCurrentPaneAndAliasRequireCallerProcess`, `TestHistoricalAliasChecksAllCandidatesBeforeChoosingProvenWorker`, `TestOverlappingCallerRejectsTwoProvenWorkerBindings`, `TestHistoricalPaneAliasRejectsStaleProcessBirth` |
| Native recovery retains birth evidence and recovers through real callbacks | `TestNativeRecoveryToolForegroundHoldsOldBirthUntilVerifiedRecapture`, `TestNativeRecoveryReadFailureHoldsOldEvidenceAndCanRecoverLater`, `TestNativeRecoveryHeldWorkerRecapturesThroughSessionEvent`, `TestNativeRecoveryHeldOnlineWorkerRetriesReadsWithoutEvent`, `TestNativeRecoveryOldCallbackSnapshotUsesCurrentHold`, `TestNativeRecoveryDifferentPaneHoldKeepsOneSubscription`, `TestNativeRecoveryHeldTargetCannotAuthorizeDifferentConversation` |
| Existing workspace/pane/cwd and explicit scope | `TestExistingPaneSpawnWaitsForShellAndKeepsRoutingAndCwd`, `TestAdoptionUsesLiveCwdAndRejectsConflictingExplicitCwd`, `TestExplicitScopeOverridesCallerButInvalidRelationshipsFail`, `TestNativeWorkspaceFlagOverridesOnlyInferredWorkspaceWithinSession`, `TestNativeWorkspaceFlagRequiresExplicitSessionForCrossSessionAdoption` |
| Durable inbox, artifacts, ask/reply, broadcast receipts | `TestInboxPersistenceArtifactsAndBusyEventDelivery`, `TestAskReplyPersistsAcrossEngineRestart`, `TestRunBroadcastCommitSnapshotsMembersAndRecipientEvents`, `TestAdhocBroadcastSnapshotsReceipts`, `TestReplyAcknowledgesOriginalReceiptWithoutConsuming`, `TestAckCannotDowngradeConsumptionOrCrossWorkerByScope`, `TestResolveCallerPathsAndStatusWithoutContent` |
| Safe automatic delivery and prompt drafts | `TestDonorANSIDrafts`, `TestLiveUnstyledClaudePlaceholderCannotProveEmptyInput`, `TestAgentReadExplicitlyPreservesAnsiStyling`, `TestNoticeCommandsCarryVerifiedActorAndRemainBounded`, `TestAckDoesNotReleasePromptLaneWithoutTurnEnd`, `TestInboxReadRecoveryDoesNotReplayUncertainMutation` |
| Completion requires report and original turn end | `TestReportNeedsMatchingTurnEnd`, `TestTurnEndBeforeReportAndAtomicAssociation`, `TestResetAndReplacedIncarnationCannotSettle`, `TestReplacementProcessCannotSettleOriginalDispatch`, `TestOriginalEndEvidenceSurvivesMailboxTurnAndBusyReportWaits`, `TestPromptResponseCannotResurrectExplicitFail`, `TestDispatchIntentRejectsBindingOrLifecycleChangedDuringReadiness` |
| Replay races, reconnect, slow readers, cancellation | `TestWaitRecoversSlowHubSubscriberFromDurableCursor`, `TestWaitTimeoutDoesNotResetAfterOverflow`, `TestQuestionWaitRepeatedOverflowReplaysReplyAndReleasesSubscription`, `TestWaitReconnectKeepsCursorCapturedBeforeFirstEvent`, `TestFollowReconnectBeforeFirstEventPreservesHead`, `TestWaitImplicitCursorSurvivesLostFirstReply`, `TestSubscriptionCancelBeforeAcknowledgment` |
| No blind mutation replay; receipts and crash boundaries | `TestLostRequestNotResent`, `TestPartialWriteUnknown`, `TestUncertainPromptIsDurableAndNeverResent`, `TestSendingIntentWithoutLiveAttemptBecomesUncertainAndNotReplayed`, `TestUncertainSpawnExposesReceiptAndNeverReplays`, `TestOperationReceiptRejectsChangedPayloadAndSurvivesRestart`, `TestCannotResolveAnExecutingOperation`, `TestShutdownPersistsInterruptedAutomaticWakeBeforeReleasingStore`, `TestInvestigatedFinalWakeResolutionPreservesReceiptAndDoesNotResend` |
| Liveness escalation without silent failure | `TestWatchdogEscalationDedupSurvivesInboxWakes`, `TestContinuousBlockedTimeoutResetsAndEscalationDeduplicates`, `TestUnobservedDispatchEscalatesAfterCrashIntent`, `TestInboxReadFailureRecoversWithoutLifecycleEvent`, `TestInboxReadRecoveryThrottlesUnchangedReadFailure` |
| Protected release and verified cleanup | `TestReleaseProtectsGitAndLeavesSharedWorktree`, `TestBusyWorkerWithoutDispatchRequiresForceForReleaseAndStop`, `TestUncertainCloseIsPersistedAndNotReplayed`, `TestSignalChecksOriginalProcessBirthImmediately`, `TestBirthIdentityRejectsReusedPIDAndNonAgentEvidence`, `TestControllingTerminalLossDoesNotProveDeath`, `TestRetirementRefusesSurvivingOrMissingRecordedProcessProof`, `TestPositiveReplacementAgentRetiresOnlyDeadOldBinding` |
| Workflow-ready core without an engine | `TestSharedRunWorktreeWorkersKeepIndependentReceiptsAndSurviveRelease`, `TestWorkersRunScopeIncludesAdhocDispatchMembership`, `TestEventReplayFiltersCursorScopeTypeAndLimit`; schema has runs/worktrees/messages/events and no workflow, node, edge, schedule or task-DAG tables |

The daemon's ownership tests establish its lock before SQLite is opened. The CLI
and client packages operate through RPC, with no writable store connection. Inbox
reads, event reads and waits do not consume messages. Optional file projections
are not implemented; handoff files are caller-owned context references.

## Live Herdr evidence

Only the uniquely named sessions `woof-p1-01a0ff95-a` and
`woof-p1-01a0ff95-b` were controlled. Test state and raw JSON observations are under
`/private/tmp/woof-p1-live-01a0ff95`. Existing default-session panes and user focus
were preserved. Live daemon runs used `bin/woofd --watchdog 0`.

1. Both sessions attached to one daemon PID and
   `/private/tmp/woof-p1-live-01a0ff95/state/woof.db`. Two workers shared the
   `claude-test` profile and `test-worker` alias in separate workspaces, each with
   the same Herdr pane ID `w1:p4`. Their distinct logical IDs routed independently.
2. Dispatch `dispatch_dbaa9d1a4036b0e163a97588dcb153b4` supplied a short prompt
   and `a/handoff.md`. Claude reported `WOOF_LIVE_A_OK`. Settlement event cursor
   38 contained the original attachment, working sequence 2, end sequence 3 and
   explicit done-message association. The watchdog was disabled throughout.
3. Message `msg_98d383507ee5d13846da42fa0e546b00` automatically reached A with
   its artifact path and was explicitly acknowledged. Receipt state separately
   recorded the wake attempt, observed working turn, wake end and acknowledgment.
4. Message `msg_c90c4ea946d4e728e04dc2cc4f739758` persisted while A was busy.
   Its first wake began only after the original dispatch ended (baseline 7), then
   was acknowledged during working sequence 8. No watchdog tick was involved.
5. A asked B the durable question `msg_59fa89d5942a1595d00c5132bc33a433`.
   The original waiter timed out during a permission-blocked agent turn. Permission
   requests were canceled, never automatically approved. Separate followup
   messages helped B use its allowed CLI command; the original question was not
   resent. Later `question wait` retrieved B's persisted `WOOF_LIVE_B_REPLY`
   (`msg_0e20aa4d7d8d3dcadb9e93a3f407d799`). A explicitly reported its failed
   initial attempt; silence did not auto-fail or redispatch it.
6. A moved from `w1:p4` to `w2:p1`, retaining logical worker
   `worker_7d844c275e9ab0598de035dc09391cf0`, attachment
   `attachment_8a719dafd2b0712befef273eec531f4f`, terminal and process birth.
   A later message to the logical worker was acknowledged at the new route.
7. Stopping B's isolated Herdr server made B visible as offline while A remained
   online and continued receiving messages. Restarting the server resumed B's
   native conversation in a new OS process. Woof held the unproven old binding;
   explicit inspection/re-adoption preserved B's logical ID and created attachment
   generation 2. Verified worker stop then cleaned the resumed process tree.
8. Restarting the daemon changed PID 84054 to 40563, preserved the same database
   and event cursor 124, reconnected both live sessions, and kept A's verified
   attachment and moved route. A final reviewed-binary restart changed PID 40563
   to 6811, retained cursor 126 and the same database, reconnected both sessions,
   and preserved A's attachment, birth and `w2:p1` route.
9. A launch with an uncertain result was inspected rather than resent. After
   live reads found no agent and only a shell, explicit operation resolution marked
   the unbound reservation failed and freed its alias. No second AgentStart was
   issued for that operation.
10. The final reviewed daemon again ran with `--watchdog 0`. Dispatch
    `dispatch_6bdccd56f3b29496b4374f2bfcebdaaf` used
    `a/final-restart-handoff.md`. Claude's explicit report contained
    `WOOF_FINAL_AFTER_RESTART_OK`. The socket-backed wait returned settlement
    cursor 132 with baseline 13, working sequence 14, end sequence 15 and
    done-message `msg_cdbc7b4bd813d1c2bb01316f39442729`, all on the original
    verified attachment. This tests the final source after restart and pane move.

## Independent review

Implementation and donor scans used `gpt-6.1-sol` subagents with separate ownership
boundaries. Independent source review used `gpt-6-astra` and authenticated Claude
Code (Opus), including adversarial lifecycle/messaging review. Reviewers' source
checks are distinct from the parent-run build, tests, race detection and live tests.

Actionable findings produced regressions and fixes for stale dispatch snapshots,
process-birth bypass via native conversation identity, pane-alias caller inference,
queued inbox read-error recovery, interrupted background work during drain,
retirement of dead replaced workers, literal workspace selection, subscription
barriers after counter resets, and separate resolution of accepted wakes without
rewriting original operation receipts.

Both GPT-6-astra and Claude's postfix source reviews identified a recovery hold
that an ordinary lifecycle event could demote to permanent identity loss. The
fix persists recovery eligibility and target, recaptures verified birth through
actual subscribed callbacks or throttled recovery-only reads, and fences the old
dispatch. It also prevents repeated subscription replacement for a held moved
target. A final bounded GPT-6-astra source review confirmed that gap resolved and
found no remaining actionable defects in the reviewed areas. Parent verification
then passed the full commands above and the final live scenario. This is bounded
review evidence, not a claim that every possible defect has been excluded.

## Limits and deferred work

- Linux binaries are cross-built; Linux runtime and process-cleanup behavior were
  not exercised on this macOS machine.
- Live agent tests used Claude Code. Other supported agent prompt formats have
  donor fixture tests; OMP automatic input remains held without a verified layout.
- Unstyled Claude placeholder text under `NO_COLOR=1` is ambiguous with a typed
  draft. Woof conservatively holds it; faithful ANSI output is required.
- No board, TUI, Web UI, file projection, workflow engine, task DAG or scheduler
  was implemented. Shared run/worktree data and scoped events remain available
  for later workflow execution.
- Binary/skill installation tests use temporary directories. No global binary,
  usage skill or Herdr plugin registration was installed during verification;
  the actual plugin-host test used and removed a separate temporary registry.

## Cleanup

Cleanup passed. A and the resumed B worker stopped through Woof's verified cleanup
path, without force. Final worker inspection showed five stopped records and the
one explicitly resolved failed launch reservation; no live workers remained.
Both named Herdr test servers then stopped and became visibly offline. The final
Woof stop acknowledgment identified PID 6811 and completed drain. All three live
test sockets were absent; the two server exec processes and daemon exec process
exited 0. Recorded worker PIDs 84846 and 20505, and daemon PIDs 40563 and 6811,
were absent. Final durable event cursor was 138.

The separate plugin-host test was also stopped and its isolated registry entry
removed. Durable JSON, review reports, logs and the test database remain under the
temporary evidence directories; no user panes or default plugin registration
were changed.

## Quality hardening — 2026-10-03

The initial five-linter audit found 167 findings (162 unchecked errors and five
Staticcheck findings). All were resolved without blanket lint suppressions.
Production cleanup failures now retain their causes and remain visible over RPC.
New regressions cover subscription deadline setup/reset failures, a caller deadline
publication race, RPC handler drain after listener failure, joined error serialization,
and SQL rollback/row-close failures including an actual SQLite constraint error.

Parent verification on macOS with Go 1.26.3 passed:

```sh
make check integration install-test vuln
golangci-lint config verify
sh -n scripts/lint.sh
git diff --check
```

The full lint/formatting run using pinned golangci-lint 2.12.2 reported zero issues.
The full tests, race detection, vet, isolated CLI/daemon scenarios and temporary
installer checks passed. A separate wrong-version probe confirmed that the lint
wrapper rejects a mismatched binary. No live Herdr sessions were controlled in
this quality follow-up.

Three implementation agents handled transport, daemon and storage findings.
Independent task reviews caught and resolved two cleanup-error visibility gaps;
a final GPT-6-astra source review found no actionable regressions in the complete
change. Review reports do not substitute for the parent-run checks above.

Pinned govulncheck 1.1.4 reported zero called vulnerabilities. It also reported
three advisories in imported packages and ten in required modules whose vulnerable
symbols were not called; this is not a claim that dependencies have no advisories.
The checked-in GitHub Actions workflow runs lint, formatting, build, test, race,
vet, integration, installer and vulnerability checks on Linux and macOS. Local
verification above does not establish a successful hosted CI run.

The first hosted [Quality run 37113047741](https://github.com/zielus/herdr-woof-v2/actions/runs/37113047741)
failed. Its macOS job passed the build/test steps but the vulnerability scan
reported one called standard-library vulnerability,
[GO-2026-4971](https://pkg.go.dev/vuln/GO-2026-4971), found in `net@go1.26`
and fixed in Go 1.26.3. The setup log showed `Setup go version spec 1.26.0`,
`Resolved as '1.26.0'`, and `go version go1.26.0 darwin/arm64`.

The original `go-version-file: go.mod` read the exact `go 1.26.0` directive;
`check-latest: true` did not widen that version constraint. The corrected
workflow uses `go-version: '1.26.x'` with `check-latest: true` to select the
latest available patch within Go 1.26, as documented by
[setup-go](https://github.com/actions/setup-go/blob/924ae3a1cded613372ab5595356fb5720e22ba16/docs/advanced-usage.md#using-the-go-version-file-input).
The module minimum remains Go 1.26.0. Vulnerability checks remain enabled without
advisory suppression. Local Go 1.26.3 results above support the patched-toolchain
choice; hosted verification was pending when this correction was prepared.

The same run's Linux job found a test compilation failure: the standard library's
`syscall.Getsid` is unavailable on Linux. The detached-bootstrap fixture now uses
the existing `golang.org/x/sys/unix.Getsid`, preserving the session-leader assertion.
The original Linux test cross-compilation failed before the correction and passed
afterward. Parent verification also passed fresh client race tests, zero-issue
lint, and `GOOS=linux GOARCH=amd64 go vet ./...`; these are compilation/static checks
for Linux, with hosted runtime tests still pending at preparation time.
