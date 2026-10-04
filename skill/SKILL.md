---
name: using-woof
description: Use when coordinating coding workers through Woof in Herdr, sending durable messages or handoff files, waiting for replies, reporting dispatch completion, or resolving an uncertain mutation outcome.
---

# Using Woof

Woof owns durable coordination. Herdr runs agents. Use the `woof` CLI for every worker-to-worker message; logical worker IDs survive pane moves. Worker aliases are unique within a workspace. Run `woof --help` and command help for supported flags.

## Scope and profiles

Injected `WOOF_*` context is validated by the daemon. Explicit `--session`, `--workspace`, `--worktree`, `--run`, or `--global` scope overrides inference. Use an explicit worker ID when a name could be ambiguous. `woof profile roster --json` shows the available presets; select `--profile` when starting a worker. A profile is a reusable raw-argument launch preset, separate from a worker's identity. Its optional `cwd` is resolved for a new worker relative to the config file (or from `~/`), and `profile show` retains the configured text. Launch precedence is explicit `--cwd`, selected worktree, profile cwd, workspace cwd. A conflicting worktree and explicit cwd, missing directory, or mismatched existing pane fails before launch. Adoption keeps the verified live cwd; profile changes do not move running workers.

After recovery, inspect the current worker binding before overriding stale injected identity. Paired `--as-worker ID --as-attachment ID` flags select the actor and clear inherited scope; explicit scope flags remain. The daemon still validates fresh attachment evidence for mutations.

Keep ANSI styling enabled for agent placeholders. `NO_COLOR=1` can make an empty Claude placeholder indistinguishable from a typed draft; Woof holds input conservatively. Fix the launch environment rather than clearing or submitting an unknown draft.

## Messages and handoffs

A message contains a short request or result plus references to caller-created files. Write detailed context into a handoff file first; send its absolute path as an artifact. Woof stores paths and message text, does not copy file contents, and does not treat a file's existence as completion evidence.

```sh
woof send --to worker:w_123 --body "Please review the API change." --artifact /absolute/path/review.md
woof inbox
woof message show --id m_123
```

Read the message and its artifacts before explicitly acknowledging it; consume it when handled. Inbox reads and event waits do not acknowledge or consume messages. Use `woof message --help` for acknowledgment/consumption commands.

`woof ask` persists a question before waiting. `woof reply --id m_123 --body "..."` answers that question. If the waiting CLI disconnects, the question and reply remain durable. Resume observation of the existing question rather than creating another one.

`woof events follow --since <seq>` replays events after the saved cursor, then follows live events. `woof wait` blocks on selected events. Use these socket-backed tools instead of polling or opening SQLite.

Without `--since`, follow and wait start at the current event head. Capture `event_cursor` from `woof status --json` before launching an action, then pass that cursor to its subsequent wait so a quick completion is included. Read reconnects keep the original cursor and timeout; timeout does not cancel durable work.

## Dispatch completion

Read the referenced handoff, perform the work, then report using the dispatch and attachment IDs supplied in its prompt:

```sh
woof done --dispatch d_123 --attachment a_456 --body "Completed and verified." --artifact /absolute/path/result.md
```

Use `--failed` for a failed outcome. Woof settles only after this report and evidence that the corresponding worker turn ended. Idle alone and a report alone are insufficient. A blocked prompt needs inspection and a decision, not a fabricated completion.

Generated dispatch and inbox commands include paired actor flags for the original verified attachment. Preserve those flags when reporting, acknowledging or replying; do not replace them with a later attachment just to bypass a stale-identity refusal.

## Uncertainty and cleanup

If a mutation returns `outcome_unknown`, keep its operation/resource ID and query the resulting state. Use `woof operation show`, `woof worker show`, `woof dispatch show`, or `woof message show` as appropriate; discover exact flags with `--help`. Never resend an uncertain message, launch, dispatch, wakeup, or close merely because its connection failed.

Stop/release protects dirty or unpublished Git work and verifies process cleanup. `--force` requires explicit authorization to override that protection. Shared worktrees remain independent of worker lifetime. Use minimal decision gates through the CLI; Phase 1 has no workflow engine or task DAG.

Never send agent-to-agent messages by calling a pane directly, inspect SQLite, answer startup dialogs automatically, or install hooks/settings into user directories as part of using this skill.
