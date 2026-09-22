---
"herdr-woof": minor
---

The journal now records agent lifecycle transitions and engine activity, on
change only.

New journal records (and therefore events, one-to-one): `agent.lifecycle_changed`
`{agentId, from, to, terminalId, raw?, replaced?}`, written by the scheduler
when an agent's observed lifecycle differs from its last journaled one (a
replaced pane occupant is a transition too), and `run.activity` `{kind, phase,
agentId?, stageId?, visit?, attempt?, detail?, result?}`, written at the start
and end of a `readiness_wait`, `revision_check`, `check_run` or
`delivery_check`. Neither is a poll sample: the scheduler derives "last
journaled" from the snapshot and repeated observations write nothing. Both
records are best effort: an append the store refuses or cannot complete is
reported through `runWorkflow({onWarning})` and never changes the run's course.
Every scheduler-owned termination ends the activities still open under the same
journal lock as `run.terminated` (`terminateRun`/`cancelRun` with
`endOpenActivities: true`), and the reducer closes whatever an earlier writer
left open at termination, so `activity.open` is empty once a run is terminated.

The snapshot gains `agents[].lifecycle {state, since, seq, terminalId} | null`,
`activity.open[]` and the counters `lifecycleChangesByAgent` and
`activitiesByKind`; a journal written before these records reads unchanged
(`lifecycle: null`, `activity.open: []`). The reducer refuses a transition from
a lifecycle other than the journaled one (`lifecycle_mismatch`), a no-op
transition (`lifecycle_unchanged`), a second start of an open activity
(`activity_open`) and an end of one that is not open (`activity_not_open`).
`woof watch` and `woof events --pretty` print one-line summaries of both.
