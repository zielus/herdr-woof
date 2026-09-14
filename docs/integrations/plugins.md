# Woof integration surfaces

Status: intended behavior. The separate scaffold branch contains wiring and
stubs; this checkout does not yet contain the plugin implementation. See the
[project assessment](../research/project-assessment.md).

## Herdr plugin

The Woof Herdr plugin connects host actions and agent/workflow metadata to the
same SDK used by other callers. It should make active work easy to find and
expose useful status, cancellation and diagnostics. A managed runtime pane is a
proposed hosting choice, not a dependency of the reusable SDK API.

Herdr's API exposes plugin actions and panes, agent operations, worktree
operations, metadata and notifications. Woof should compose these supported
surfaces instead of reproducing them.
[Herdr socket API](https://herdr.dev/docs/socket-api/).

Generic diff review, file browsing and navigation integrations remain optional.
A missing community plugin must not prevent the core workflow from running.
Woof owns the review workflow and artifact contract even when an optional tool
displays the diff or review.

## Claude Code plugin

The native plugin teaches the caller to start or address agents, delegate work,
run a named workflow with structured input, inspect progress, handle attention,
and retrieve the result and artifacts. Commands and skills should describe those
capabilities in terms of the common Woof model.

Invocation admits work and returns its identity. Waiting may return an active
snapshot when the caller's wait budget expires; that is distinct from failure of
the run itself. Completion returns a structured outcome with artifact references.
The plugin must expose a usable path through the SDK or a CLI bridge without MCP.

The caller should remain available while worker agents perform the workflow.
Whether an admitted run outlives caller shutdown depends on the selected hosting
contract and must be verified explicitly.

## SDK and CLI

`HerdrAgentsSDK` exposes reusable runtime and workflow capabilities without UI
dependencies. Keep direct agent delegation useful as well as multi-stage runs.

The CLI can bridge shell-capable callers into the SDK and provide validation,
diagnostics, run listing, status, observation, cancellation, and result submission.
Structured input should be passable through a file or standard input. Exact
commands and flags remain to be specified; examples in earlier drafts are not
working commands in this checkout.

## Optional MCP

An MCP adapter may expose the same operations to external MCP-capable clients.
It owns protocol translation, not gates, agent identity, storage, or scheduling.
Neither worker completion nor Claude Code workflow invocation may require it.

The scaffold currently registers MCP and its servers advertise no tools. That
is useful protocol scaffolding, not evidence that workflows work. Review its
manifest and skill text when integrating it so an optional adapter does not
become a mandatory architecture by accident.

## Runtime support

Claude Code is the initial caller integration. Worker roles should resolve
through an explicit runtime capability boundary, keeping Claude, Codex and other
Herdr-supported agent kinds possible. The initial tested worker set remains open;
the brief does not settle a Claude-only restriction. Report unsupported role
configurations before dispatch and document the actual support matrix once tested.
