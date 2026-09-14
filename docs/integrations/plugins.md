# Woof integration surfaces

Status: foundation only. The SDK, workflow runtime, agent delegation, run
inspection, result submission, and observability contracts are not implemented.

## CLI

The built `woof` executable has three supported commands:

- `woof --help`
- `woof --version`
- `woof doctor`

`doctor` reports the local availability of `herdr status` and `claude --version`.
It is diagnostic only and succeeds even when either executable is absent. All
workflow-oriented commands fail explicitly as not implemented; the CLI does not
invent run state or host a runtime pane.

## Herdr plugin

`herdr-plugin.toml` registers a build step and a single `doctor` action. It
does not register run actions, panes, lifecycle events, or a workflow host.

For local wiring checks after a build:

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
