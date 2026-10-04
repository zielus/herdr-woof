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

Workers, Inbox, Decisions, Events and Profiles use one selected tab. At 100 columns
or wider, list and details sit side by side. In smaller panes Enter opens detail;
Esc returns. Below 60 columns or 16 rows a minimum-size notice is shown.

- `1`–`5` / Tab: switch tab; arrows or j/k: select; `/`: filter.
- `s`: scope picker; `r`: refresh; `?`: help; Esc: back/clear; `q`: quit outside editor.
- `n`: new short message; `o`: new question; select the recipient worker explicitly.
- Human Inbox: `p` reply, `a` acknowledge, `x` consume.
- Decisions: Enter opens the decision form for an open, actionable gate; resolved
  or stale gates open read-only detail. The confirmation includes the full question.
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
