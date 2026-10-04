# Worker permissions and blocked alerts verification — 2026-10-04

Branch `claude/blocked-notify` from master `7b2117b`. Go 1.26.3, macOS
(darwin/arm64), Herdr 0.9.3 / protocol 22, Claude Code 2.1.289, codex-cli
0.160.0. Linux was not exercised locally.

## Commands

Run from the worktree root at code head `98fd61b`.

| Command | Result |
| --- | --- |
| `make check` (build, test, race, vet, lint) | Passed: `go test` and `go test -race` ok for all 12 tested packages, vet clean, golangci-lint `0 issues` |
| `make integration` | Passed: all isolated RPC scenarios |
| `make install-test` | Passed: install/idempotence/opt-in skill/uninstall/conflict preservation |

## Automated evidence

| Requirement | Tests |
| --- | --- |
| Injected arguments per agent kind, socket used, nothing for other kinds or an unsafe socket path | `TestWorkerPermissionArgsPerAgentKind`, `TestCodexGrantUsesTheSocketWoofdListensOn` |
| Launch choices and opt-out suppress injection; arguments recorded and passed | `TestWorkerPermissionsRespectLaunchChoices`, `TestSpawnAddsRecordsAndPassesDefaultPermissions`, `TestSpawnPermissionsOptOutConflictAndOtherKinds` |
| Claude list covers only the worker flow; identity reads are exact rules | `TestClaudeAllowListIsTheWorkerCoordinationFlowOnly`, `TestClaudeAllowsOnlyTheTwoExactIdentityReads` |
| State directory mode changed only when wrong | `internal/paths` `TestResolveOnlyChmodsWhenTheModeIsWrong` |
| First alert, human escalation, once per episode, re-arm, dispatch untouched | `TestBlockedDispatchAlertsInvokerThenHumanOncePerEpisode`, `TestBlockedWorkerWithoutDispatchAlertsHumanOncePerEpisode`, `TestBlockedShorterThanDebounceNeverAlerts`, `TestBlockedUnblockedBeforeEscalationTimeoutNeverReachesHuman` |
| Routing to run invoker, unavailable or unreachable invoker | `TestBlockedRoutesToRunInvokerWithoutDispatchAndToHumanOtherwise`, `TestBlockedDispatchWithUnavailableInvokerAlertsHuman`, `TestBlockedUnreachableInvokerFallbackIsTheOnlyHumanEscalation` |
| Episode survives restart, reconnect and re-adoption | `TestBlockedEpisodeSurvivesEngineRestartAndReobservation`, `TestBlockedEpisodeSurvivesSessionReconnect`, `TestBlockedEpisodeAcrossReadoption` |
| Blocked dispatch is not also `no_activity` | `TestBlockedDispatchIsNotAlsoReportedAsInactive` |
| Notification result, OS fallback, detection rule | `internal/herdr` `TestNotifyReportsWhetherHerdrShowedIt`, `TestAgentExplainRule`; `TestBlockedAlertShownByHerdrNeedsNoFallback`, `TestBlockedAlertNotShownByHerdrFallsBackOncePerAlert`, `TestNotificationToUnreachableSessionFallsBack`, `TestBlockedAlertQuotesHerdrDetectionRuleVerbatim` |

## Live evidence, phase 1: cause analysis

Master `7b2117b` binaries, `woofd --watchdog 0`, isolated state and config,
dedicated Herdr session `woof-perm-exp` (stopped and deleted afterwards). Raw
evidence: `/private/tmp/claude-501/-Users-zielu-Projects-herdr-woof-v2/f9295104-b4c2-41d2-9c23-f169cb046f60/scratchpad/exp/ev`.
Prompts were answered only as recorded experiment steps in test panes.

1. **Claude Sonnet, default launch.** Message and dispatch flow ran with no
   prompt. Each command is marked `Allowed by auto mode classifier`.
2. **Claude Haiku, default launch.** Status line `manual mode on` and
   `auto mode unavailable for this model`. 15 prompts: 5 for the message flow
   (`inbox`, `message show`, `ack`, `reply`, `consume`), 10 for the dispatch
   flow. All "This command requires approval"; a `$VAR` command gave "A variable
   in this command can't be checked before it runs".
3. **Codex, default launch.** The worker's shell reported another pane's
   `WOOF_WORKER_ID` and `WOOF_STATE_DIR`: tool commands inherit the environment
   of the shared `codex app-server --managed-daemon`. The worker refused to act.
   `--no-daemon` gave the correct identity.
4. **Codex with `--no-daemon`, GPT-6-Astra and `gpt-5.6-luna`.** No prompt;
   every `woof` command failed after about 8 s with `context deadline exceeded`.
   `codex sandbox ... -- woof status` reproduced it, and
   `--allow-unix-socket <sock>` fixed it. With a state directory outside the
   writable roots the CLI failed earlier with `chmod ... operation not permitted`.
5. **Manual candidate arguments** (the same lists Woof now injects, without the
   `printenv` rules). Haiku: basic flow silent; `worker stop`, `worker start`,
   `schedule list`, `session list`, `python3`, `curl`, `herdr`, an absolute path
   to `woof`, a `VAR=1 woof` prefix and a `$VAR` argument each prompted. Sonnet
   in auto mode: nothing prompted, including the out-of-scope commands. Codex,
   both models: every `woof` command ran, `curl` and the Herdr socket were
   blocked.
6. **Codex `-c` syntax.** A dotted key with a quoted socket path fails to parse
   (`unknown variant`); the table must be one inline value. `network.enabled=true`
   without `network_proxy` let `curl` reach the internet.
7. **Herdr.** `agent get` exposes only `agent_status: "blocked"`; `agent explain`
   exposes `matched_rule.id`. `notification.show` returned
   `{"shown":false,"reason":"disabled"}` with the default Herdr config.

## Live evidence, phase 2: implementation

Worktree binaries (`6de5224`, then rebuilt with the two fixes below),
`woofd --watchdog 2s --blocked-timeout 20s --blocked-escalation-timeout 60s`,
state directory `~/.cache/woof-perm-exp2` with its socket inside it, dedicated
Herdr session `woof-perm-exp2` started with its own `HERDR_CONFIG_PATH` and a
`ZDOTDIR` wrapper that put the test binaries first on `PATH`. Every worker
reported `which woof` as the worktree build. Raw evidence:
`/private/tmp/claude-501/-Users-zielu-Projects-herdr-woof-v2/f9295104-b4c2-41d2-9c23-f169cb046f60/scratchpad/exp2/ev`.
No launch arguments were added by hand; `woof worker start` output showed the
injected arguments for each worker.

### Permissions

1. **Basic flow, final build.** Haiku, `gpt-5.6-luna` and GPT-6-Astra each ran a
   message flow and a ten-step dispatch flow (identity reads, `dispatch check`,
   `worker show`, `dispatch show`, `inbox`, `status`, `send`, `done`) with 0
   prompts. All three dispatches settled with "all ok".
2. **Identity read.** On the first build the skill's
   `printenv WOOF_WORKER_ID WOOF_ATTACHMENT_ID` prompted on Haiku and printed
   only the worker ID, so the Astra worker stopped for lack of an attachment ID.
   After the fix, `printenv WOOF_WORKER_ID` and `printenv WOOF_ATTACHMENT_ID`
   ran silently on Haiku.
3. **No filesystem grant.** Both Codex workers used the state directory under
   `~/.cache`, outside the sandbox's writable roots, and every `woof` command
   worked. `touch` inside that directory was refused.
4. **Out of scope, Haiku.** `woof worker stop`, `woof schedule list` and
   `woof worker start` each showed "This command requires approval" and were
   denied. `woof session list` and `python3 -c` were issued in the same batch
   as a denied command and were cancelled with it; they did not run.
5. **Out of scope, Codex luna.** `worker stop`, `schedule list`, `session list`
   and `worker start` all reached the daemon. `python3` ran in the sandbox.
   `curl`, `herdr workspace list` and a write to the state directory failed.
6. **Opt-out and conflict.** With `defaults.worker_permissions: false` a claude
   worker started with `["--model","haiku"]` and a codex worker with no
   arguments. A profile carrying its own `--settings` started with exactly its
   own arguments.

### Blocked alerts

Lead = a live Sonnet worker that issued the dispatch and created a run.

| Time | Observation |
| --- | --- |
| 21:42:02 | Haiku worker `h2`, dispatch from lead, blocks on `woof worker stop` |
| 21:42:22 | `dispatch.escalated` `continuously_blocked` to lead, body ends `Herdr detection rule: bash_permission_prompt.` Herdr result `disabled`; OS banner presented |
| 21:43:24 | `dispatch.escalated` `blocked_unresolved` to human, body starts `Still blocked after worker ... was notified.` OS banner presented |
| 21:43:32 | `no_activity` to lead: a third alert for the same block (fixed, see below) |
| 21:45:47 | Daemon restarted with the fix while still blocked; no new escalation in 50 s |
| 21:46:50 | Prompt denied (recorded step); alert fields cleared |
| 21:46:58 | Next step blocks on `woof schedule list`; daemon restarted 7 s into the debounce |
| 21:47:18 | One new `continuously_blocked` to lead, 21 s after the block began |
| 21:48:02–08 | Two further prompts denied within seconds; no alert |
| 21:48:27 | Worker reported; dispatch `settled`, `turn_ended` true. It stayed `active` through every alert |
| 21:48:51 | `h2`, no dispatch and no run, blocks on a direct `python3` request |
| 21:49:12 | `worker.escalated` `continuously_blocked` to human; nothing further in 100 s |
| 21:51:19 | `h3`, member of the lead's run, no dispatch, blocks. Herdr toast delivery enabled in the test session's own config, client attached |
| 21:51:40 | `worker.escalated` `continuously_blocked` to lead; toast shown, no daemon log line, no OS banner |
| 21:52:42 | `worker.escalated` `blocked_unresolved` to human; toast shown, no OS banner |

- **OS notification.** For each fallback the macOS unified log has
  `usernoted ... Presenting <NotificationRecord app:"com.apple.ScriptEditor2" ...>`
  from `/usr/bin/osascript` at the alert's second
  (`ev/os-notification-unified-log.txt`). The frontmost application was the
  same before and after. The banner itself was not looked at.
- **Toast.** `notification.show` returned `disabled` by default,
  `no_foreground_client` with `delivery = "herdr"` and no client, and `shown`
  with a client attached in a detached tmux; the toast text was captured from
  that client.
- **Lead.** It was woken by each alert addressed to it, read and consumed the
  message and took no other action, as instructed.

## Fixes made during verification

| Commit | Problem seen live | Change |
| --- | --- | --- |
| `9fa4c52` | Skill identity read prompted on Haiku and returned one variable on macOS | Skill reads one variable per command; two exact `printenv` allow rules; regression test |
| `98fd61b` | One block raised `no_activity` as a third alert | `no_activity` skipped while the worker is blocked; regression test |

## Not verified

- The `no_activity` fix on a live dispatch blocked longer than the quiet
  timeout; it is covered by its regression test only.
- Rule shapes no worker used: `woof message ack/consume`, `woof question wait`,
  `woof events ...`, `woof ask`, `woof operation show`.
- Claude allow rules on a Sonnet worker after injection; phase 1 covered the
  same rules passed by hand.
- An unavailable or unreachable invoker, and re-adoption during a block, live;
  covered by tests.
- The Linux `notify-send` fallback, and `rate_limited`/`busy` results from a
  real Herdr.
- Whether the user saw the OS banners: Do Not Disturb or notification settings
  for Script Editor can hide a presented notification.
- Toast behavior in the user's own Herdr session and with a real terminal
  client; `terminal` and `system` delivery modes.
- Production daemon, database, workers and Herdr configuration were not
  touched or used.
