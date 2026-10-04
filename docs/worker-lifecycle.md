# Worker Lifecycle

## Worker identity

A worker has a stable Woof ID.

Example:

```text
w_01J...
```

Human-friendly name:

```text
reviewer
```

Herdr runtime references:

```text
session id
workspace id
pane id
agent name
```

are mutable attachment details.

Do not make pane ID the worker identity.

## Start

A worker may start:

1. in the current workspace as a new tab,
2. in a specified existing workspace,
3. in an existing empty pane,
4. with a specified worktree/cwd.

The launch profile determines agent kind + raw CLI args.

Woof records the resolved profile used.

## Adopt/register

Allow adopting a live Herdr agent/pane into Woof.

Registration must validate enough identity information to avoid accidentally attaching to a reused pane identifier.

Use lessons from `herdr-projects` and `herdr-orch` around Herdr ID reuse and lifecycle reconciliation.

## Runtime states

Keep the state set small.

Suggested:

```text
starting
idle
working
blocked
offline
released
stopped
failed
```

Distinguish Woof lifecycle state from raw Herdr agent status where useful.

`blocked` means Herdr recognized an approval or question UI. Woof does not
answer it. Workers started by Woof get default launch permissions for their own
coordination commands, and a block that persists is reported once per episode
to the requester and then to the human; see
[permissions-and-blocked-alerts.md](permissions-and-blocked-alerts.md).

## Completion/settlement

Port the strong `herdr-orch` rule.

A dispatch is completed only when:

1. the worker reports completion explicitly, and
2. Herdr shows that the corresponding turn is no longer working.

If the worker becomes idle without a completion report:

- do not automatically mark completed,
- do not immediately fail,
- watchdog emits/nudges/escalates according to policy.

## Stop/release

Port `herdr-orch` safety behavior where practical:

- refuse destructive close when tracked worktree has uncommitted/unpushed work unless explicitly forced,
- archive useful transcript/output if configured,
- close pane,
- verify processes are gone,
- escalate if cleanup fails.

## Retain

Support a retained worker that remains alive but is excluded from generic auto-assignment.

Useful for reviewers or long-lived roles.

## Recovery

After daemon restart:

1. load live workers from DB,
2. reconnect relevant Herdr sessions,
3. inspect referenced panes/agents,
4. validate identity,
5. update worker runtime attachment,
6. mark missing workers offline/failed according to evidence,
7. resume watchdog supervision.

Never act on a pane solely because its numeric/string ID matches an old record.

## Future workflow lifetime

Phase 2 should support persistent workflow workers.

Example:

```text
workflow run
  ├─ builder
  ├─ reviewer
  └─ verifier
```

These workers may live for the full workflow run and alternate between idle and active states.

Do not force spawn/kill per workflow node.
