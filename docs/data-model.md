# Data Model

This is a logical model. Exact SQL types and migration layout are implementation details.

## IDs

Use stable Woof IDs for durable entities.

Suggested prefixes:

```text
s_    session
ws_   workspace
wt_   worktree
r_    run
w_    worker
m_    message
d_    dispatch
e_    event
g_    gate
sched_ schedule
srun_  schedule run (occurrence)
```

Do not use Herdr pane IDs as durable entity IDs.

## sessions

```text
id
herdr_name
socket_path
status
created_at
last_seen_at
metadata_json
```

Status examples:

```text
attached
offline
stale
```

## workspaces

```text
id
session_id
herdr_workspace_id
cwd
name
created_at
updated_at
```

## worktrees

```text
id
workspace_id
path
repo_path
branch
ownership_kind
owner_run_id nullable
created_at
updated_at
```

Woof may track a worktree without owning its creation.

## workers

```text
id
session_id
workspace_id
worktree_id nullable
run_id nullable

name
profile_name
agent_kind

herdr_pane_id nullable
herdr_agent_name nullable

state
retained
created_at
updated_at
last_seen_at
```

Important:

- `name` is a human-friendly alias within its scope.
- `id` is canonical.
- `profile_name` records how the worker was launched.
- pane identity may change after recovery.

## runs

A run is one top-level execution instance.

```text
id
kind
session_id
workspace_id nullable
worktree_id nullable
invoker_worker_id nullable
invoker_pane_ref nullable

title
status
created_at
updated_at
completed_at nullable
metadata_json
```

Initial kinds:

```text
adhoc
```

Reserved for Phase 2:

```text
workflow
```

Do not make `run` mean task, message, workflow node, and everything else.

## messages

```text
id
run_id nullable
from_worker_id nullable
to_worker_id nullable
to_kind
subject
body
kind

status
reply_to_message_id nullable

created_at
delivered_at nullable
acknowledged_at nullable
consumed_at nullable
```

Possible kinds:

```text
note
question
reply
done
escalation
control
```

Possible delivery states:

```text
queued
delivered
acknowledged
consumed
failed
```

Keep semantics minimal; do not invent transitions that are not used.

## dispatches

```text
id
run_id
worker_id
task_ref nullable
spec
status
attempt

sent_at
observed_working_at nullable
done_message_id nullable
settled_at nullable
outcome nullable
```

Settlement must preserve the `herdr-orch` idea:

- an explicit worker completion report alone is insufficient,
- idle alone is insufficient,
- completion is settled using both report + observed lifecycle state.

## gates

```text
id
run_id nullable
question
options_json
status
decision nullable
created_at
resolved_at nullable
```

## events

Append-only.

```text
seq INTEGER PRIMARY KEY AUTOINCREMENT
event_id
type
session_id nullable
workspace_id nullable
worktree_id nullable
run_id nullable
worker_id nullable

actor_kind
actor_id nullable

payload_json
created_at
```

`seq` is the replay cursor used by event subscribers.

Never update/delete event rows during ordinary operation.

## profiles

Profiles should remain configuration, not DB-owned runtime state.

Workers record `profile_name` and resolved launch metadata for audit/debugging if needed.

## schedules

Native time scheduler (schema version 2). A time trigger, not a workflow table.

```text
id                 sched_...
session_id
workspace_id
worktree_id nullable
worker_id          resolved once at creation; never a pane
target_name        alias at creation, display only
name               unique among non-removed schedules in a workspace
cron               5-field, descriptor or @every
timezone           IANA zone, persisted at creation
missed             latest | skip
action             message | dispatch
subject, body      message action
spec, handoff      dispatch action
enabled
state              active | removed
anchor_at
next_run_at nullable
last_run_at nullable
created_at
updated_at
removed_at nullable
```

## schedule_runs

One durable occurrence per row.

```text
id                 srun_...
schedule_id
session_id, workspace_id, worktree_id nullable, worker_id
run_id nullable
occurrence_key     t:<ms> | manual:<request-id> | missed:<ms>
trigger
action
state              persisted | claimed | dispatching | dispatched | uncertain
                   | failed | blocked | skipped | missed | cancelled
reason nullable
scheduled_for
missed_count, missed_last nullable
attempts
attempt_id nullable          operation receipt of the current dispatch attempt
next_attempt_at nullable
message_id nullable
dispatch_id nullable
claimed_at
updated_at
finished_at nullable
```

`(schedule_id, occurrence_key)` is unique, so an occurrence is claimed at most once. Messages and dispatches carry `schedule_run_id` for provenance.

Timestamps are UTC Unix milliseconds. `*_local` fields in API output are display-only RFC 3339 text in the schedule zone.

## Future workflow tables

Do not implement in Phase 1.

Reserve conceptual room for:

```text
workflow_runs
workflow_node_runs
workflow_role_bindings
workflow_events
```

These may extend `runs` rather than duplicate them.

Decide only when Phase 2 starts.
