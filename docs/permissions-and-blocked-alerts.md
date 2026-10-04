# Worker permissions and blocked alerts

Two related behaviors:

1. Woof adds launch arguments so a `claude` or `codex` worker it starts can run
   its own coordination commands without a prompt or a sandbox failure.
2. When a worker still sits at an approval or question UI, the watchdog tells
   the requester once per block, and the human once if nobody resolves it.

Woof never answers a prompt. Evidence for everything below is in
[permissions-and-blocked-alerts-verification.md](permissions-and-blocked-alerts-verification.md).

## Why workers were blocked

Measured on Claude Code 2.1.289 and codex-cli 0.160.0 with an unmodified launch.

| Cause | Layer | Effect |
| --- | --- | --- |
| Claude in manual permission mode | Claude Bash permission rules | Every `woof` command asks: 15 prompts for one message and one dispatch |
| `$VAR` in a command | Claude Bash permission rules | "A variable in this command can't be checked before it runs"; no allow rule covers it |
| Codex sandbox | Seatbelt blocks the AF_UNIX connect to `woofd` | No prompt; every `woof` command fails after 8 s with `context deadline exceeded` |
| State directory `chmod` on every CLI call | Woof, surfaced by the Codex sandbox | `chmod <state dir>: operation not permitted` before the connect |
| Codex shared app-server daemon | Codex launch default | Tool commands inherit another pane's `WOOF_*` identity |

Claude Sonnet in auto mode showed no prompts: its classifier allowed each
command. Auto mode is not available on every model. Claude Haiku starts in
manual mode ("auto mode unavailable for this model"), and the smallest Codex
model tested, `gpt-5.6-luna`, was run without relying on any approval feature.
The defaults therefore do not depend on auto mode or on Codex auto-review.

## Injected launch arguments

`woofd` puts these before the profile's arguments and any `--arg` values. The
effective arguments are stored on the worker and shown by `woof worker show`.

### Claude

```text
--settings {"permissions":{"allow":[...]}}
```

Prefix rules, each `Bash(<command> *)`:

```text
woof inbox            woof message show     woof message ack
woof message consume  woof ack              woof consume
woof reply            woof dispatch show    woof dispatch check
woof done             woof worker show      woof status
woof operation show   woof wait             woof question wait
woof events list      woof events follow    woof send
woof ask
```

Exact rules: `Bash(printenv WOOF_WORKER_ID)` and
`Bash(printenv WOOF_ATTACHMENT_ID)`.

`--settings` merges with the user's settings. It does not replace them.

### Codex

```text
--no-daemon
--enable network_proxy
-c permissions.woof={extends=":workspace",network={enabled=true,mode="limited",unix_sockets={"<woofd socket>"="allow"}}}
-c default_permissions="woof"
```

`<woofd socket>` is the socket the daemon listens on, including the short
`/tmp/woof-<uid>/` fallback for a long state path. `network.enabled=true` is
only ever emitted together with `network_proxy`: without the proxy it opens all
network access. No filesystem grant is added. The CLI now changes the mode of
the state directory only when it is not already `0700`, so a sandboxed worker
needs no write access to it.

## What is and is not granted

| | Claude | Codex |
| --- | --- | --- |
| Own inbox, message show/ack/consume, reply | allowed | allowed |
| Dispatch show/check, done | allowed | allowed |
| Worker show, status, operation show, wait, events | allowed | allowed |
| Send and ask | allowed, any recipient | allowed, any recipient |
| Worker start/stop/release/adopt, dispatch, nudge, fail | still prompts in manual mode | **allowed** |
| Schedule, session, gate, run, operation resolve | still prompts in manual mode | **allowed** |
| Other shell commands | unchanged | unchanged (run inside the sandbox) |
| Internet, Herdr socket, writes outside the workspace | unchanged | blocked |

## Limitations

- **Codex grant is per socket.** A Codex worker holding it can run every `woof`
  command. Codex cannot narrow a launch by subcommand. Execpolicy rules can, but
  they load only from `~/.codex/rules/` or a trusted project's `.codex/rules/`,
  not from launch arguments, and with `approvals_reviewer = "auto_review"` a
  `prompt` rule is approved without reaching a human.
- **Claude allow rules do not restrict auto mode.** In auto mode the classifier
  decides every command the rules do not cover; in the live run it allowed
  worker start/stop and schedule commands. Only `ask` rules make those prompt,
  and Woof does not add any.
- **Rules match command text.** An absolute path to `woof`, a `VAR=value`
  prefix or a `$VAR` argument is not matched and asks. The rules are a
  convenience, not a security boundary.
- **Recipients are not scopable.** `woof send` and `woof ask` reach any worker,
  and actor flags are free text. Scoping belongs in `woofd`.
- `network_proxy` is an experimental Codex feature.
- Folder-trust dialogs and other startup dialogs are not covered.

## Skill command shapes

The `using-woof` skill keeps worker commands in shapes the rules match: start
with `woof`, write IDs literally, one `woof` command per shell call. A worker
reads its identity with `printenv WOOF_WORKER_ID` and
`printenv WOOF_ATTACHMENT_ID` as two commands; macOS `printenv` prints only the
first name it is given.

## Blocked alerts

A block episode starts when Herdr reports the worker `blocked` and ends when it
reports anything else. Alert state lives on the worker record
(`blocked_at`, `blocked_alerted_at`, `blocked_alert_delivery_id`,
`blocked_escalated_at`) and is cleared when the episode ends.

| Step | When | Recipient |
| --- | --- | --- |
| First alert | Block lasts `--blocked-timeout` (default 20s) | The requester, else the human |
| Human escalation | First alert went to a worker and the block lasts another `--blocked-escalation-timeout` (default 5m) | The human, once |
| Re-arm | The worker leaves the block and blocks again | A new episode, same steps |

- **Requester.** The invoker of the active dispatch's run. Without an active
  dispatch, the invoker of the run the worker belongs to. A worker never
  receives its own alert. An invoker that is released, lost, offline, stopped
  or failed is skipped.
- **Human-first alerts are final.** When the first alert goes to the human
  there is no second escalation for that episode.
- **Unreachable requester.** If the requester's wakeup stays queued past the
  quiet timeout, the existing "Escalation could not reach invoking worker"
  message goes to the human and counts as the episode's human escalation.
- **No repeats.** Ticks inside an episode send nothing further. A blocked
  dispatch is not also reported as `no_activity`.
- **Inform only.** Alerting never answers the prompt and never settles, fails,
  nudges or redispatches a dispatch. Settlement still needs the worker's report
  and turn-end evidence.
- **Restart.** The episode and its alert state persist, so a daemon restart
  mid-debounce or after an alert sends no duplicate.
- **Limitation.** An unblock and re-block that happen entirely while the daemon
  is down are not observed and count as one episode.

The message names the worker, how long it has been blocked, the workspace, the
dispatch and handoff when there is one, and the commands to inspect it. When
Herdr's `agent.explain` reports a matched rule, its id is quoted verbatim
(`Herdr detection rule: bash_permission_prompt.`). Herdr exposes no other
reason for a block, so Woof does not claim to know which prompt is waiting.

Events: `dispatch.escalated` when the worker has an active dispatch,
`worker.escalated` otherwise. `payload.reason` is `continuously_blocked` for
the first alert and `blocked_unresolved` for the human escalation.

## Human channel

Each alert also asks Herdr for one notification (`notification.show`). Herdr
reports whether it was shown:

| Herdr result | Meaning | Woof |
| --- | --- | --- |
| `shown` | Toast displayed in an attached client | Nothing more |
| `disabled` | `[ui.toast] delivery` is `off`, the Herdr default | Log and OS fallback |
| `no_foreground_client` | No client attached | Log and OS fallback |
| `rate_limited`, `busy`, RPC error | Not shown | Log and OS fallback |

The OS fallback is one banner per alert: `osascript` on macOS (shown under
"Script Editor"), `notify-send` on Linux. A banner does not take focus. To get
Herdr toasts instead, set in Herdr's `config.toml`:

```toml
[ui.toast]
delivery = "herdr"
```

The durable record is always the escalation message in the human inbox
(`woof inbox --id human --all`); notifications are best effort.

## Operator configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `defaults.worker_permissions` in `config.yml` | `true` | `false` adds no launch arguments for any worker |
| `woofd --blocked-timeout` | `20s` | Block duration before the first alert |
| `woofd --blocked-escalation-timeout` | `5m` | Further block duration before the human escalation |
| `woofd --watchdog` | `1s` | Tick interval; `0` disables all watchdog alerts |

A launch that already chooses its permissions is left alone. See
[profiles.md](profiles.md#default-worker-permissions) for the exact flags.
