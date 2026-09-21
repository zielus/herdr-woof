---
"herdr-woof": minor
---

The journal now records host lifecycle, cancellation requests and observation
loss, and followers read through to the host's exit.

New journal records (and therefore events, one-to-one): `host.claimed`,
`host.exited`, `host.lost`, `run.cancel_requested`, `observation.lost` and
`observation.recovered`. Every cancel path (`woof run cancel`, the Web UI, the
Herdr action, a host signal, `runWorkflow({signal})`) goes through the shared
`cancelRun`, which journals who asked and the termination under one lock. The
snapshot gains `lifecycle {host, cancelRequested, observationLost}`.
`host.exited` is the one record allowed after `run.terminated`.

`woof events --follow`, `woof watch --follow` and the Web UI's event stream no
longer end at `run.terminated` while the run's host is still alive: they wait
for its `host.exited` (at most three host heartbeats, and not at all when the
host is provably gone), also when resumed with `--after` at the terminated
cursor. Exit codes are unchanged. `woof status --wait` still returns on the
recorded outcome at once; `host.exited` may follow, and resuming from its
`status.cursor` delivers it.

`openRun` takes an optional `host` and journals `host.claimed` under the same
lock as `run.opened` (returned as `hostClaimed`), so a cancel racing the open can
no longer leave a hosted run without host records. The scheduler derives
unresolved observation losses from the snapshot instead of its own memory.
