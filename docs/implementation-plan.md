# Woof Phase 1 implementation plan

Approved design: `docs/*.md` and the plan approved in this chat on 2026-10-03.

## Donor map

* herdr-orch: adapt `internal/herdr/client.go`, `internal/rpc/rpc.go`, daemon subscription/bootstrap ownership, SQLite transactions/migrations, mailbox/ask/reply, generic event machinery from day-plan events, worker launch/release, and dispatch/escalation tests. Preserve MIT attribution. Reject per-session databases/daemons, pane-keyed worker identity, task DAG/day plans/schedules/UI, consuming reads, weak settlement, and unsafe retry classification.
* herdr-projects: translate profile name/argv/home expansion and roster behavior, prompt draft detection, nudge suppression, and plugin/skill ergonomics into Go. Reject files-only state, normalized provider/model/effort policy, and polling-driven normal progression.

Reference checkout HEADs recorded during verification: Orch
`7aacbedb1a811e049a23ca9c90658f2a47f9bab9`; Projects
`4e4548c3c43888e6be1c96906215998f07dc63f0`. Per-component source/test
provenance is recorded beside the adapted runtime, transport, profiles and prompt
code, with full MIT notices in `THIRD_PARTY_NOTICES.md`.

## Decisions

One global `~/.woof/woof.db`, daemon socket and lock; config `~/.woof/config.yml`. `WOOF_STATE_DIR`/`WOOF_CONFIG` isolate tests. All clients use RPC; only the lock-owning daemon opens the writable store. Repeated plugin attach refreshes the selected session without daemon takeover. Session outages do not terminate the daemon. RPC versions must match; daemon restart is explicit.

Logical IDs and per-incarnation attachment evidence are durable. Alias uniqueness is within an active workspace. Profile environment overrides are deferred; raw argv supports only predictable home expansion. Existing/adopted panes use validated bindings rather than pretend environment injection.

Messages carry short text and stored artifact paths; caller-created handoff files hold detail. File contents are not copied or canonical runtime state. Automatic inbox delivery prompts the right ready agent and queues while busy/blocked/draft. Persist per-recipient wake/delivery/ack/consume state separately. Broadcast recipients are snapshotted atomically. Ask targets one worker/human. Dispatch with no run creates a single-dispatch adhoc run without permanently binding its worker.

Settlement requires a dispatch/attachment-specific report plus positive original-turn-end evidence. Report/state/event writes are atomic. Confirm subscriptions before submit; fence overlap/reconnect callbacks. Characterize protocol 22 completion counters before using them for recovery. Unknown/stale/reset evidence never settles work. Persist operation intent before external effects and expose uncertainty at both RPC boundaries, without automatic mutation replay.

Orch escalation is preserved: durable contextual escalation to the invoking logical worker, human fallback, urgent Herdr notification. Defaults: watchdog 1s, idle missing report 3m, unobserved/missing evidence/uncertain wake 90s, blocked 20s. Persist suppression by dispatch/reason; mailbox turns do not restart alerts. Explicit nudge/fail/read remain available. Release protects dirty/untracked/unpublished/unverifiable Git work, preserves shared worktrees, validates agent process birth before signaling, and verifies cleanup.

## Task 1: Foundation and store

Create Go binaries/build targets and shared model. Implement scoped SQLite tables, transaction/event helpers, append-only protection, operation receipts, uniqueness and crash atomicity. Adapt store tests and add restart/schema/scope tests.

## Task 2: Transport and clients

Adapt Herdr protocol22 client/subscriptions, NDJSON RPC, global paths, detached bootstrap and retry classification. Add malformed/partial/EOF/cancel uncertainty and socket ownership tests. No side effect may be guessed safe to replay.

## Task 3: Profiles, prompt safety, artifacts and packaging

Translate thin YAML profiles/roster and safe prompt checks with donor fixtures. Build bounded notices from short messages/artifact paths. Add manifest, build/install support, usage skill and provenance. No provider resolver, workflow or UI.

## Task 4: Global daemon and session lifecycle

Implement singleton/versioning/drain, independent multi-session loops, fresh attach/recovery, subscription readiness, durable scoped identity and inference, replay/follow/wait. Tests must show one PID/DB, isolated outages and replay across restart.

## Task 5: Workers, messaging, dispatch and gates

Implement launch/adopt/recovery, automatic inbox processing, durable ask/reply and broadcast receipts, original-turn settlement, minimal gates and persistent escalation. Unit tests exercise new/replaced/moved workers, busy queue, stale/report order, delivery uncertainty and watchdog-disabled normal progression.

## Task 6: Release, integration and final review

Implement safe release/stop and process verification. Run build/test/race/vet, CLI tests, uniquely named live Herdr sessions and authenticated Claude review. Keep default/user panes untouched. Track every acceptance item with concrete evidence; document actual commands once targets exist. No goal completion until core evidence and independent review are complete.

## Review-driven decisions

A pane move can bring two active workers with the same alias into one workspace.
The moved worker keeps its logical ID and incarnation; its alias gets a short
stable ID suffix, with the prior alias and reason recorded in an event. A local
alias conflict must not disconnect unrelated workers or the Herdr session.
Aliases remain conveniences; explicit worker IDs continue to route globally.

Subscription readiness is tied to the worker attachment as well as the session
subscription generation. Launch/re-adoption and subscription setup can overlap;
a stale snapshot must never mark a newly bound worker missing. Native session
continuity may locate a worker after both pane and terminal references change,
but rotates the attachment and invalidates the old turn baseline. Such dispatches
receive durable attention and need explicit investigation/failure/re-adoption.

Wake attempts have durable operation receipts. Explicit investigation can mark
an uncertain attempt abandoned or resolved, without automatically resending it.
Another prompt still requires fresh live identity, readiness and empty-editor
evidence. Acknowledgment proves receipt; it alone does not free the prompt lane.

Process liveness uses PID and birth identity even after its controlling TTY is
lost. A TTY mismatch never proves death; unverifiable or surviving processes
remain visible cleanup failures. Destructive signaling still revalidates identity.

When a current pane and another worker's historical pane alias overlap, caller
inference checks every candidate against the caller's process ancestry and the
recorded agent birth. Exactly one proven candidate is required. A lone current
binding still requires fresh live attachment evidence. Generated worker commands
carry explicit worker and original attachment IDs, so they do not depend on
mutable pane environment variables.

Native conversation continuity cannot erase recorded process evidence. Recovery
holds the worker until it can capture a verified agent process birth, then creates
a new attachment generation. Foreground tools and transient inspection failures
retain the old evidence and cannot establish dispatch completion.

A dead old worker can be retired when its pane is absent or belongs to a different
terminal, including a replacement agent. Retirement is a database-only operation:
it checks the old process birth and Git protection without closing or signaling
the replacement. Shared worktrees remain intact.

Investigating an accepted wake with missing turn-end evidence records a separate
resolution decision; it does not rewrite the original successful operation
receipt, resend the prompt, or invent dispatch settlement evidence. Raw Herdr
workspace selectors are resolved only inside the selected session.

Daemon restart acknowledgment includes the draining daemon PID. Read probes may
retry after EOF, but the stop mutation is never resent after uncertainty. Bootstrap
waits for the canonical ownership lock to be released or the owner to become
healthy before launching a replacement; concurrent observers reuse that owner.

An incomplete native recapture remains a durable recovery hold, distinct from
identity loss. Matching lifecycle callbacks can complete verified recapture;
the watchdog may retry bounded reads when the session is healthy but no event
arrives. Neither path can erase old birth evidence, replay a prior mutation or
complete a dispatch from the previous attachment.
