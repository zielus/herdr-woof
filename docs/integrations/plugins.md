# Woof integration surfaces

Status: foundation, plus a p1 result-handoff prototype and a p2 run-facts/
snapshot prototype. Result submission (p1) and run inspection/observability
(p2: run plans, journaled facts, snapshots, events and a Herdr runtime
adapter, `woof run show`) now exist as CLI/SDK contracts (see below). The
workflow runtime, agent delegation and run hosting are not implemented, and
the Herdr and Claude Code plugins still expose none of any of it — every
capability below is a CLI/SDK surface only, never a plugin action.

## CLI

The built `woof` executable has six supported commands:

- `woof --help`
- `woof --version`
- `woof doctor`
- `woof attempt open` — declares an open attempt and its owner in a run
  journal (`<runDir>/journal.jsonl`) and creates its artifact directory.
- `woof submit` — validates a result envelope and its artifact against that
  journal and records the outcome: accepted, duplicate, or one of a closed
  set of machine-readable rejection reasons.
- `woof run show <run-dir> [--verify-artifacts]` — prints a read-only JSON
  snapshot of a run journal: status, agents, per-stage attempts, counters,
  and any ambiguous deliveries still open. It takes no journal lock, never
  contacts Herdr, and works on a terminated run and on a p1 journal.

`doctor` reports the local availability of `herdr status` and `claude --version`.
It is diagnostic only and succeeds even when either executable is absent.
`attempt open` and `submit` are a p1 prototype — see
[communication.md](../architecture/communication.md#implemented-now-p1-prototype)
for the envelope, decision order, journal, and its correlation-not-authentication
limit. `run show` is a p2 prototype — see
[domain model](../architecture/domain-model.md#implemented-now-p2) and
[observability](../architecture/observability.md#implemented-now-p2) for the
snapshot shape and what it does not yet cover. Every other workflow-oriented
command fails explicitly as not implemented; the CLI does not invent run
state or host a runtime pane.

## Herdr plugin

`herdr-plugin.toml` registers a build step and a single `doctor` action. It
does not register run actions, panes, lifecycle events, or a workflow host;
`attempt open`, `submit` and `run show` exist only as CLI/SDK surfaces, not
plugin actions.

The manifest builds from a repository checkout, so it is not part of the npm
package. For local wiring checks after a build:

```sh
herdr plugin link .
```

This confirms manifest integration only. It is not evidence that Woof can run
an orchestration workflow.

## Claude Code plugin

`plugin/claude/` provides a command and skill that plainly state that workflow
execution is unavailable. It registers no tools, hooks, background process, or
transport adapter.

For local validation:

```sh
claude plugin validate plugin/claude --strict
claude --plugin-dir plugin/claude
```

## Deferred adapters

MCP is deferred and is not maintained in this repository. A future adapter may
translate a stable SDK contract, but it must remain outside the SDK and cannot
become a required path for workflow admission or worker completion.
