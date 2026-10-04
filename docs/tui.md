# Woof TUI (Phase 1.5)

Build with `make build`, then launch `bin/woof tui` in a terminal. The existing
installer places `woof` on PATH, so installed use is `woof tui`.

The TUI is a human operator RPC client of the global daemon. It opens all sessions
by default and deliberately ignores inherited worker/pane identity. Scope flags
`--session ID`, `--workspace ID`, `--worktree ID`, `--run ID`, and `--global` select
the initial browsing scope. These are Woof IDs, not raw Herdr pane IDs.
`WOOF_STATE_DIR` and `WOOF_CONFIG` work as for other CLI commands.
After upgrading binaries, run `woof daemon restart` to drain and replace an older
resident daemon. The TUI needs the additive `events.tail` RPC; an older daemon
reports `unknown_operation` until restarted. Existing CLI/RPC operations retain
their protocol and behavior.

## Views and navigation

Workers, Inbox, Decisions, Events, Profiles and Schedules use one selected tab.
At 100 columns or wider, list and details sit side by side. In smaller panes
Enter opens detail; Esc returns. Below 68 columns inactive tabs shorten to their
number keys. Below 60 columns or 16 rows a minimum-size notice is shown.

- `1`–`6` / Tab: switch tab; arrows or j/k: select; `/`: filter.
- `s`: scope picker; `r`: refresh; `?`: help; Esc: back/clear; `q`: quit outside editor.
- `n`: new short message; `o`: new question; select the recipient worker explicitly.
- Human Inbox: `p` reply, `a` acknowledge, `x` consume.
- Decisions: Enter opens the decision form for an open, actionable gate; resolved
  or stale gates open read-only detail. The confirmation includes the full question.
- Schedules: `e` enable, `d` disable, `u` run now. Each opens a review showing
  the schedule name, ID, action, target worker and effect; Enter submits once.
- Forms: Tab changes fields; Ctrl+s reviews; submission requires confirmation.

Color-capable terminals use a bold header, underlined active tab, full-width
reverse selection and restrained status colors. Red indicates failures/stale
state, yellow indicates attention, and green indicates healthy/resolved state.
The palette uses the terminal's own basic ANSI colors without imposing a
background. `NO_COLOR=1 woof tui` disables styling; ASCII and `TERM=dumb` retain
plain labels and the `>` selection marker. Names and statuses precede full IDs in
lists, while details and action review retain the complete identity.

Reading does not acknowledge or consume messages. Worker mailboxes are read-only.
Sending and asking preserve short text and artifact paths; one artifact reference
per line in the form, relative to the operator cwd. Confirmation shows resolved,
deduplicated absolute paths and their current accessibility. Missing files remain visible
limitations. File references preserve locations, not contents.

## Schedules

The Schedules tab (`6`) lists the native schedules in the browsing scope that have
not been removed (`schedule.list`). Each row shows name, enabled/disabled, action
(message or dispatch), target worker name, last occurrence state and next run in
the schedule's zone (`disabled` when disabled). The last state comes from the
daemon's joined `last_run`, so loading needs no per-schedule reads. An explicit
`--run` scope lists only schedules whose occurrences dispatched into that run;
browse by session, workspace or worktree for the rest. Selection is keyed by schedule
ID and survives reorders, filtering and reloads. Detail is read on demand with
`schedule.show` for the selected schedule. It shows the full identity (ID,
session, workspace, worktree, target worker ID and name), cron, time zone, missed
policy, message body or dispatch spec/handoff, next run, the next five
occurrences and recent runs. Each run shows its state, trigger, local scheduled
time, reason/error, linked message deliveries or dispatch status, report,
outcome and turn-end evidence, plus any attempt receipt.

Run states keep persistence, acceptance and settlement apart. `persisted` means
the message was queued, not that the work is complete. `dispatched` means the
prompt was accepted; settlement is shown separately and still requires a done
report and turn-end evidence. The occurrence becomes `settled` (green, reason =
reported outcome) or `failed` only when its dispatch settles or fails. A due time
that arrives while an occurrence is outstanding is counted on that occurrence
(`Skipped while outstanding: N`), and nothing is queued for it. `uncertain`
occurrences are never resent; inspect the attempt with `woof operation show --id ID`.
State badges keep their text in plain terminals.

The tab is read-only except enable, disable and run now. Adding and removing
schedules stays in the CLI (`woof schedule add`, `woof schedule remove`).
Run now executes synchronously in the daemon. The result notice names the
occurrence and its state. If its dispatch prompt outcome is unknown, the
attempt operation is recorded like any uncertain mutation and never resent.
If the run-now response itself is lost, the request receipt completes once the
occurrence is claimed, before any dispatch attempt. Its state is therefore not the
dispatch outcome. `i` and the exit printout also read the occurrence's current
state and its attempt receipt (`attempt_id`).
The daemon reports `run_outstanding`, `schedule_removed` and `not_found` as
definite rejections. Any `schedule.*` event, including every `schedule.run.*`
state, marks the shown detail as refreshing. Like other events, it triggers the usual
coalesced reload, and every successful reload re-reads the visible detail once.
If that reload fails, the detail says it is stale and shows the error. Schedule
read failures stay in this tab and never make other tabs stale. An older daemon
(`request_id_required` or `unknown_operation`) is reported as "daemon lacks
schedules; run `woof daemon restart` after upgrading".

## Runtime behavior

Events drive normal updates. Reconnect uses replay cursors; stale data remains
visible and actions are disabled until a successful reload. Profiles reload on
entry/manual refresh. The event tab retains the latest 500 matching events; older
history remains available through `woof events list`.

A completion report and its turn-end evidence are displayed independently. Idle
or a report alone does not mean a dispatch settled. Worker launch, dispatch, stop,
release and terminal output remain in CLI/Herdr. Quitting the TUI leaves woofd and
agents running.

Only one mutation runs at a time. Unknown outcomes are never automatically resent;
inspect the displayed operation with `woof operation show --id ID` and investigate
resource state before using CLI operation resolution. An absent receipt does not
prove no action occurred. On quit or signal, an active mutation gets its existing
bounded deadline to finish before terminal restoration and outcome output. A
definite rejection during shutdown returns an error after restoration. Help and
minimum-size notices suspend confirmation keys; resizing preserves the draft.

## Reuse

Terminal model and async command patterns adapt herdr-orch cmd/herdr-orch/board.go
(MIT, Stephen Ellington). Scope picker/filter/need-attention interactions and tests
adapt herdr-projects src/popup.rs and src/sidebar.rs (MIT, Elias Stravik). Donor
polling, pane identity and workflow board structure are not carried forward.

Verified behavior and live observations are recorded in [tui-verification.md](tui-verification.md).
