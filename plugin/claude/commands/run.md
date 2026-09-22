---
description: Start a Woof workflow run in Herdr and report its structured outcome
argument-hint: "[--workflow <name>] <task description>"
allowed-tools: Bash(node:*), Bash(woof:*), Read
---

You delegate one task to Woof. Woof runs the workflow's agents in Herdr panes
next to this one and records every step in a run journal. You start the run,
wait for it, and report its result. You do not do the task yourself.

Task from the user: $ARGUMENTS

If `$ARGUMENTS` starts with `--workflow <name>`, that name is the workflow and
the rest is the task; otherwise the workflow is the configured default. Built in:
`build-review` (builder, reviewer) and `plan-build-review` (a planner ahead of
them, whose plan every builder turn receives as an input). A project may define
others in its `.woof/workflows/`; `WOOF config show --workflow <name>` says
whether a name resolves and from where.

## 1. Pre-flight

Woof diagnostics for this directory, through `dist/cli.js` next to this plugin,
else through `woof` on PATH:

!`node -e "const fs=require('fs'),cp=require('child_process');const args=['doctor','--json','--repo',process.cwd()];const cli=process.argv[1];const r=fs.existsSync(cli)?cp.spawnSync(process.execPath,[cli,...args],{stdio:'inherit'}):cp.spawnSync('woof',args,{stdio:'inherit'});if(r.error)console.log('Woof is not built or installed: no '+cli+' and no woof'+' on PATH')" "${CLAUDE_PLUGIN_ROOT}/../../dist/cli.js" 2>&1`

- If that printed a JSON object, call the CLI as `node <woof.node> <woof.cli>`
  (both values from the JSON) for every command below. This text writes that
  command as `WOOF`.
- If it printed no JSON, stop and tell the user Woof is not built or installed
  (in a Woof checkout: `bun run build`).
- If `herdr.env` is `false`, stop and tell the user `/woof:run` must be invoked
  from Claude Code running inside a Herdr pane.

## 2. Build the workflow input

Write one JSON object:

- `schemaVersion`: `1`
- `repo`: the absolute git top level of the working directory, unless the user
  named another repository.
- `task.title`, `task.description` and a non-empty `task.acceptanceCriteria`
  list of strings, stated concretely from the user's request and this
  conversation.
- `constraints`, for `plan-build-review` only: a non-empty array of non-empty
  strings the plan must respect, when the user named any. Omit it otherwise.
- `verify`: only when the user or the project names a verification command. It
  is an object with exactly two fields: `command`, a non-empty array of strings
  (the program and each argument separately, never one string), and
  `timeoutMs`, a required integer number of milliseconds.
- Omit `agents` unless the user asked for specific agent kinds or models; the
  Woof configuration supplies them.
- Omit `checkout` unless the user said where the run should work. Inside
  Herdr a run defaults to a new Herdr worktree on branch `woof/<runId>`; add
  `"checkout": {"mode": "current"}` to work in the repository itself (its tree
  must be clean for a workflow that edits it), or `{"mode": "worktree",
"branch": "<name>", "base": "<ref>"}` to choose the branch and its base.
- Never add permission-bypass arguments on the user's behalf.

Both built-in workflows take the shape below. A workflow that is neither takes
whatever its own definition validates, which this command does not know: build
the input from what the user gave you, start the run, and report exit 2's
`details` verbatim rather than guessing at fields.

A complete example (replace the values; drop `verify` when no command was
named):

```json
{
  "schemaVersion": 1,
  "repo": "/absolute/path/to/the/repository",
  "task": {
    "title": "Implement slugify",
    "description": "Add slugify(text) in src/slugify.mjs with node:test tests.",
    "acceptanceCriteria": ["slugify lowercases its input", "tests pass with node --test"]
  },
  "verify": { "command": ["node", "--test"], "timeoutMs": 600000 }
}
```

## 3. Folder trust

Always apply this gate before starting, whatever the repository: use
`trust.status` from the pre-flight JSON when `repo` is the working directory;
otherwise run `WOOF doctor --json --repo <repo>` and use its `trust.status`.
When `trust.status` is `untrusted` or `unknown`, tell the user: "the operator
must open `claude` in <repo> once and accept its folder-trust question; Woof
never answers it". Continue only after the user confirms.

## 4. Start the run

Run `WOOF run start --project <repo> --input -` with the JSON on stdin through
a heredoc, adding `--workflow <name>` when the user named a workflow.

- Exit 2: report `reason`, `message` and `details` verbatim, fix every field the
  details name (all of them, in one change), and retry once. If the retry is
  rejected too, report that rejection and stop. Do not ask a follow-up question
  through an interactive menu instead: no run exists yet, and Herdr may show
  this pane as done while the menu waits, so nobody watching the run sees it.
- Exit 3: report the rejection and stop.
- Exit 0: report `runId`, `runDir`, the host pane, each agent's kind and model
  with its configuration source, and any warnings.

## 5. Wait

Run `WOOF status <runDir> --wait --timeout-ms 540000` with a Bash timeout of
600000 ms, and act on its exit code:

- 7: say the run is still running (its active stage and round), then wait again.
- 9: tell the user `status.attention.blocked.requiredAction` verbatim
  (`startup_blocked` means a trust or permission question in an agent pane).
  Wait again with `--allow-blocked` only after the user says it is resolved or
  asks to keep waiting.
- 8: the run's owner is gone without recording an end (lost, or exited after
  an interruption). Report it, with `hostOutcome.reason` and
  `hostOutcome.message` when the output has `hostOutcome`, and suggest
  `woof run cancel <runDir>`. Never cancel unasked.
- 0, 4, 5 or 6: go to step 6.

## 6. Report

This step applies to every terminal exit code: 0, 4, 5 and 6. From `result`,
report `outcome`, `reason`, `limit` and `counters.rounds`.

The artifact references may be null. `artifacts.review` is null unless
`outcome` is `completed`, and stays null for a workflow that has no review stage
even when it completed; `artifacts.completion` and `artifacts.verification` can
be null for any outcome. Report `artifacts.review.acceptedPath`,
`artifacts.completion.acceptedPath` and `artifacts.verification.path` only for
a reference that is not null, and say "none" for a null one. Read the accepted
review file and summarize its findings only when `artifacts.review` is not
null.

`artifacts.lastAcceptedByStage` holds every stage's latest accepted artifact by
stage id, whatever the workflow's stages are called. Report its
`acceptedPath`s for any stage the three named references do not already cover —
that is where a plan, or an external workflow's own artifact, is found.

Print the `result` JSON line in a fenced block. Claim success only when
`outcome` is `completed`.

## Never

- Answer or dismiss an agent's permission or folder-trust prompt.
- Run `claude -p`, or pass `--dangerously-skip-permissions` or any other
  permission-bypass flag.
- Edit `~/.claude.json` or Herdr configuration.
- Send input or keys to agent panes.
- Cancel a run without the user asking.
