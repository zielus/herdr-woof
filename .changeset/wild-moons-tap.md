---
"herdr-woof": minor
---

New command `woof ui`: a local dashboard for your runs.

It serves a run list and a run detail view on `http://127.0.0.1:4317`, reading
the same journals `woof runs`, `woof status` and `woof events` read — no new
state and no journal lock. The run view shows the stage and agent state, a live
event timeline over server-sent events that resumes from its cursor after a
reconnect, and the blocked agent's required action when there is one. Cancelling
a run from the UI goes through the same call `woof run cancel` makes.

What the engine cannot do, the UI will not pretend to: answering a blocked
agent, retrying an attempt and starting a run are shown disabled with the reason
they are unavailable, and their endpoints answer `501`.

It binds loopback by default, checks the `Host` header against an allowlist,
requires a matching `Origin` on anything that writes, and refuses `--host`
beyond loopback unless you pass `--token`. Run `woof ui --help` for the flags;
`docs/architecture/web-ui.md` covers the security model, reaching it from a
phone, and the known gaps.

The package still declares no runtime dependencies.
