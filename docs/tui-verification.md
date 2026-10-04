# Phase 1.5 TUI acceptance

Verified on 2026-10-04 in the managed `codex/woof-tui` worktree, based on
`origin/master` at `533867f`. This is the human operator TUI specified in
[tui-plan.md](tui-plan.md); usage and keys are in [tui.md](tui.md).
Workflow execution, Web UI, agent terminal output, worker launch, dispatch and
lifecycle controls are outside this TUI's scope.

## Automated evidence

Toolchain: Go 1.26.3, macOS arm64. `go.mod` retains Go 1.26.0. Both binaries use
pinned Bubble Tea 2.0.10, Bubbles 2.2.1 and Lip Gloss 2.0.6 through `internal/tui`.

- [x] `make check`: build, all-package tests, race detection, vet, lint and formatting.
- [x] `make integration`: isolated CLI/daemon scenarios.
- [x] `make install-test`: reversible installer verification.
- [x] `make vuln`: exit 0; zero reachable vulnerabilities. Findings in unused
  dependency code are not represented as zero dependency vulnerabilities.
- [x] CLI help and clear non-terminal failure before daemon bootstrap:
  `TestTUIHelpDoesNotBootstrap`, `TestTUIRejectsNonTerminalBeforeStateCreation`.

| Contract | Regression evidence |
| --- | --- |
| Human actor, global default, explicit scope | `TestNewRPCBackendIsolatesHumanActorAndGlobalScope`, `TestTUIExplicitScopeAndGlobalDefault`, `TestTUIRejectsMachineOutputAndActorOverride` |
| Captured event head, bounded scoped tail, snapshot/replay race | `TestEventTailSparseScopeAndBounds`, `TestEventTailExcludesCommitAfterCapturedHead`, `TestRPCBackendSnapshotCursorPrecedesViewReads` |
| Reconnect, cancellation, consumer failure, stale reads | `TestRPCBackendFollowReconnectsAcceptedCursorAndNotifiesLoss`, `TestRPCBackendFollowCancellationClosesIdleStream`, `TestRPCBackendFollowConsumerFailureDoesNotRetry`, `TestReadStartedBeforeDisconnectCannotRestoreReadiness` |
| Stable IDs, scope races, event bursts without polling | `TestStableSelectionAcrossReloadAndPaneMove`, `TestReloadKeepsSelectedWorkerInsideActiveFilter`, `TestScopeGenerationRejectsOldReadsAndCallbacks`, `TestHealthyLoadHasNoPollingAndEventsCoalesceRefresh`, `TestEventRingBoundedAndDeduplicated` |
| Human mailbox permissions, canonical scope and recipient | `TestMessageActionsRequireHumanOwnedReceipt`, `TestActionRechecksStaleHumanReceiptBeforeMutation`, `TestActionRejectsReplyWhenCanonicalSenderDiffersFromReview`, `TestActionPreservesSessionWideRunForReusableWorker` |
| Messages, ask/reply, explicit receipts, artifacts, gates | `TestActionDaemonAskReplyReceiptsAndArtifacts`, `TestActionDaemonRejectsScopeDriftAndValidatesGate`, `TestFormReviewCanonicalizesArtifactReferencesBeforeConfirmation`, `TestHumanReceiptEventsIdentifyHumanActor` |
| Duplicate submission, uncertainty and shutdown outcome | `TestQuitWaitsForMutationReceiptAndDuplicateConfirmBlocked`, `TestActionUncertaintyPreservesOperationAndNeverResends`, `TestLaterSuccessPreservesUncertainOperationForInspectionAndExit`, `TestShutdownReceiptReturnsOnlyPendingMutationFailure` |
| Responsive Unicode rendering, hostile content and confirmation visibility | `TestResponsiveViewAndHostileContent`, `TestUnicodeSafeTextRemovesBidiAndIncompleteEscapes`, `TestPickerSelectedLongRowVisibleAtMinimumSize`, `TestFormGateViewportKeepsSelectedLongOptionVisible`, `TestHelpOwnsActionAndConfirmationKeys`, `TestTinyReviewSuspendsConfirmationPreservesDraftAndCanQuit`, `TestHelpScrollKeysRemainAvailableAtMinimumSize` |
| Resolved gate detail and terminal restoration | `TestNarrowGateDetailForResolvedAndStaleOpen`, `TestGateReviewIncludesFullFrozenQuestion`, `TestRunQuitRestoresAlternateScreen`, `TestRunExternalCancellationCancelsReads`, `TestQuitDrainsDetachedMutationThenPrintsReceiptAfterRestore` |

The final combined `make check integration install-test vuln` exited 0. Its raw
output is retained at `/private/tmp/woof-tui-live-20261004/final-check.log`.

Implementation owners used separate transport, UI and action boundaries. Each
received an independent spec/quality review. The final gpt-6-astra adversarial
review found three P2 issues (hidden confirmation keys, shutdown error propagation,
and narrow resolved-gate detail), all fixed and re-reviewed. Its adjacent P3 help
scroll issue was reproduced, fixed and covered by a permanent regression. All five
independent overlay probes passed after that fix. No review blocker remains.
Donor MIT notices and component provenance are in `internal/tui/LICENSE.MIT` and
`internal/tui/PROVENANCE.md`.

## Live Herdr evidence

Only owned sessions `woof-tui-20261004-a` and `woof-tui-20261004-b` were controlled.
Both hosted authenticated Claude Code 2.1.289 with the `claude-test` raw-argv
profile, the same worker alias, and pane `w1:p1`. Their durable worker IDs differed:

- A: `worker_c65737318d717b94dbe796fc62459bc1`.
- B: `worker_690ab72fd9a75a8f564cad001e970dec`.

Both sessions shared `/private/tmp/woof-tui-live-20261004/state/woof.db`. Initial
`woofd --watchdog 0` PID 45029 handled messaging and gates. Draining restart
replaced it with PID 87226, preserving the database, both sessions and worker IDs;
the TUI event stream resumed. Live receipt details and screen captures are retained
under `/private/tmp/woof-tui-live-20261004` as local, non-portable observations.
Automated regression tests above remain the reproducible evidence.

- [x] Inherited worker/attachment environment did not replace the TUI's human actor
  or global scope; both workers were visible and recipient review used durable IDs.
- [x] TUI send persisted `msg_982284b7b2ab2ebb7d2c892cc71113d9` with the absolute
  `handoff.md` reference. Initial unstyled Claude input was held safely. A separate
  readiness turn enabled delivery of that queued message, without a resend.
- [x] TUI ask `msg_f56a9383ded17fcfa4d3da588114f470` carried `question-handoff.md`.
  Claude's durable reply `msg_2c3fdd3594e891c8dd5043f0f37242a3` contained
  `WOOF_TUI_ANSWER_OK`.
- [x] Claude asked the human question `msg_7a6e32960e83f55eff6865588951fe14`;
  the TUI submitted the explicit reply `WOOF_TUI_HUMAN_REPLY_OK`.
- [x] Separate TUI ack and consume confirmations produced durable receipts.
  Live inspection exposed an existing human receipt event mislabeled as a worker;
  it was fixed with red/green tests, and a final live ack event identified `human`.
- [x] TUI resolved `gate_2b7a37c506d31b048cbf127103b415c4` as `approve`; the
  final resolved-gate view, scope picker and literal profile argv were inspected.
- [x] `q`, SIGINT and SIGTERM restored the foreground shell and terminal
  `icanon`/`echo`. Signals targeted only the discovered TUI foreground process.
- [x] Cleanup refused normal worker stop because the implementation worktree was
  dirty. Explicit forced stops of only our two test workers succeeded; their
  shared worktree remained intact. Empty agent lists were verified before stopping
  the isolated daemon and the two named test sessions.

Claude initially requested approval for an unallowed compound shell command.
That request was canceled, not approved. Subsequent artifact guidance used Read
and individually permitted absolute Woof commands. This is an observed live setup
limitation, not evidence of uninterrupted first-turn success. Existing user panes,
default Woof state and user focus were preserved.
