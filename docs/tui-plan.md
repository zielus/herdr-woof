# Woof TUI implementation plan

Goal: deliver Phase 1.5 monitor, human inbox and decisions as `woof tui`.
Architecture: one RPC client of the existing global daemon; no database writes in UI.
Tech: Go 1.26.0 minimum, Bubble Tea 2.0.10, Bubbles 2.2.1, Lip Gloss 2.0.6.
Spec: accepted user plan and Phase 1.5 in docs/phases.md.

## Constraints and design
New managed worktree on codex/woof-tui from origin/master. Workers, Inbox,
Decisions, Events, Profiles tabs. Default global human actor, optional explicit
session/workspace/worktree/run scope. Clear all inherited worker/attachment/pane/socket
actor fields. No terminal output, launch, dispatch, lifecycle, workflow or Web UI.
English keyboard-first UI. Width >=100: list/detail split; smaller: Enter opens
full detail; below 60x16: minimum-size notice. Keys 1-5/Tab, arrows/j/k, / filter,
s scope, r refresh, ? help, Esc back, q quit outside editor. Forms require review
before submission. Explicit human ack/consume, never on read. Worker inbox read-only.
Latest 500 scoped events then follow from global cursor captured before fetching
views. Coalesce invalidations; generation fence stale results. Disconnection keeps
stale visible data and disables actions until successful reload. Profile refresh
on entry/manual. Stable ID selection, safe Unicode/control-sequence rendering.
Frozen mutation target/scope; serialized actions, no resend after uncertainty.
Independent 10s mutation deadline drained on quit/signals, then terminal restored
and uncertain operation ID printed. Operation resolution stays in CLI.

## Shared interfaces
internal/tui/types.go is controller-owned; all tasks use the Backend interface.
RPCBackend contains Base *client.Client. Transport owns NewRPCBackend, Load,
Follow and Operation. Actions owns RPCBackend.Act and action/form helpers.
Load obtains events.tail first and then canonical lists, returning cursor and
scoped snapshot. Follow emits StreamUpdate with event or disconnection error, reconnecting from the last
event callback successfully accepted; caller cancellation must terminate promptly.
The UI reloads on stream error with bounded retry until successful; a live stream
alone does not restore readiness. No polling once reads/stream are healthy.
UI owns Run(ctx, scope, stdout) error, called by CLI only after checking terminal.
UI may use global load for picker/recipient catalogue, scoped load for contents.
The controller owns CLI routing, dependencies and final integration documentation.

## Task 1: Transport and bounded events
Owned files: internal/tui/backend.go and its tests; internal/store event tail;
internal/daemon/core.go read routing + tests; internal/client read classifications;
internal/model event-tail response. Do not edit types.go or UI/actions files.
- [x] Adapt relevant donor store/reconnect edge-case tests, observe red.
- [x] Add events.tail read with limit default/max500: capture global head H, query
  matching seq<=H DESC LIMIT, return ascending events with event_cursor H.
  Preserve existing list/follow semantics; classify tail/follow read-only.
- [x] NewRPCBackend clears inherited actor and scope; keeps operator PID/cwd.
- [x] Load typed lists, explicit human inbox all receipts, report messages/artifact
  status, profiles metadata+resolved args, global catalogue on global scope.
- [x] Follow cursor loop with bounded reconnect backoff and cancellation. Emit
  ConnectionError on lost stream so UI disables controls until successful reload.
- [x] Test sparse scopes, bounded tail, snapshot/replay race, cursor reconnect,
  identity isolation and scope filters; run package checks and report.

## Task 2: Terminal model and views
Owned files: internal/tui/model.go, view.go, picker.go, run.go and corresponding
tests, LICENSE.MIT/provenance. Do not edit backend/actions/types/CLI files.
- [x] Inspect donor board.go and projects popup/sidebar tests; observe red for
  stable selection, picker wrapping, filtering/Escape and responsive views.
- [x] Implement five tabs and detail views, report+turn-end distinction,
  message receipts/artifact status, worker mailbox read-only, profile literal argv.
- [x] Support selectors/catalogue and new-message recipient selection by worker ID.
- [x] Async load/follow via Backend, coalesced refresh, per-scope generation fencing,
  bounded500 event ring, last snapshot retained stale on disconnect/error.
- [x] Forms call task3 helpers; mutations use detached bounded10s context. Keep
  pending action result on quit/signal, disable competing Tea signal handler,
  drain before exit and print uncertain operation ID after restore.
- [x] Add Unicode/control sanitization, no color-only state, scrolling, empty/error
  states, keyboard help, alt-screen restoration. Test scope races, duplicate
  submits, quit during mutation and hostile content; run package checks/report.

## Task 3: Actions and forms
Owned files: internal/tui/actions.go, actions_rpc.go, form.go and corresponding
tests. Do not edit shared types or transport/UI/CLI files.
- [x] Write failing ownership, frozen-target, artifact and confirmation tests.
- [x] NewWorkerAction(kind,w,browse), NewMessageAction(kind,entry),
  NewGateAction(gate). Worker action scope actual session/workspace/worktree,
  compatible selected run only. Reply scope original question. Human receipt
  ownership enforced; reply only unreplied question addressed to human.
- [x] Form NewForm(Action); Update(tea.Msg) (Form,tea.Cmd); View(width,height)
  string; Review() (Action,error). Form edits fields, options and newline-separated
  artifact refs. Ctrl+s requests review via exported FormReviewMsg; Esc cancel.
- [x] Act resolves artifact refs against operator cwd, uses explicit human scoped
  client, existing send/ask/reply/ack/consume/gate.resolve; ask no wait. Validate
  IDs/body/gate decisions before RPC. Preserve uncertain operation ID/result.
- [x] Test real daemon receipts/ask/reply/artifacts where feasible and lost-response
  no resend; run package checks and report.

## Task 4: Integration, review and acceptance
- [x] CLI tui registration rejects JSON and actor override, uses explicit scope or
  global, help works without bootstrap, non-terminal error before client creation.
- [x] make check, integration, install-test and vuln; repair failures.
- [x] Independent task reviews, then gpt-6-astra whole-branch adversarial review.
- [x] Live named isolated Herdr sessions: Claude messaging, question/reply,
  artifact, gate, daemon restart and UI terminal restore; preserve existing focus.
- [x] Document real commands and test/live evidence. Commit only verified changes.
