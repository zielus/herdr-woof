---
name: woof
description: Coordinate other coding agents running as live Herdr sessions from this Claude Code session. Use when the user wants to delegate a task to another agent, run a workflow across agents, or check on agent sessions Woof manages. Currently scaffolding only — the woof MCP server exposes no tools yet.
allowed-tools: mcp__woof__*
---

# woof

Woof is a Herdr plugin, a Claude Code plugin, and an orchestration SDK that
lets this Claude Code session coordinate other coding agents running as live
Herdr sessions.

This session talks to Woof through the `woof` MCP server (registered by this
plugin's `.mcp.json`). Use its tools to start, steer, and check on
workflows and delegated agent sessions.

**Current state:** scaffolding only. The `woof` MCP server is wired up and
responds to `initialize`/`tools/list`, but advertises zero tools — there is
no orchestration logic yet. If a task needs one of these tools and it is not
there, say so plainly rather than improvising a substitute.
