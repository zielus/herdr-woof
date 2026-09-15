---
description: Start a Woof build-review run in Herdr and report its structured outcome
argument-hint: "<task description>"
allowed-tools: Bash(node:*), Bash(woof:*), Read
---

You delegate one build-review task to Woof. Woof runs a builder and a reviewer
agent in Herdr panes next to this one and records every step in a run journal.
You start the run, wait for it, and report its result. You do not do the task
yourself.

Task from the user: $ARGUMENTS

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
- `verify`: only when the user or the project names a verification command. It
  is an object with exactly two fields: `command`, a non-empty array of strings
  (the program and each argument separately, never one string), and
  `timeoutMs`, a required integer number of milliseconds.
- Omit `agents` unless the user asked for specific agent kinds or models; the
  Woof configuration supplies them.
- Never add permission-bypass arguments on the user's behalf.

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
a heredoc.

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
- 8: report that the run's owner is lost and suggest `woof run cancel <runDir>`.
  Never cancel unasked.
- 0, 4, 5 or 6: go to step 6.

## 6. Report

From `result`, report `outcome`, `reason`, `limit`, `counters.rounds`,
`artifacts.review.acceptedPath`, `artifacts.completion.acceptedPath` and
`artifacts.verification.path`. Read the accepted review file and summarize its
findings. Print the `result` JSON line in a fenced block. Claim success only
when `outcome` is `completed`.

## Never

- Answer or dismiss an agent's permission or folder-trust prompt.
- Run `claude -p`, or pass `--dangerously-skip-permissions` or any other
  permission-bypass flag.
- Edit `~/.claude.json` or Herdr configuration.
- Send input or keys to agent panes.
- Cancel a run without the user asking.
