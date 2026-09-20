# A second agent kind: pi

Status: proposal, 2026-09-20. Based on source at `38b44b5` (Woof 0.2.0), Herdr
0.9.1 and pi 0.86.0 (`@earendil-works/pi-coding-agent`). Closes the "A second
agent kind" limit in [v1 evidence](../acceptance/v1-evidence.md) once a live run
passes. Flags below were read from `pi --help` and pi's bundled `README.md` and
`docs/security.md`; re-check them against the installed version before relying
on them.

## Goal

A role may set `kind: "pi"`. Woof starts that agent through Herdr, delivers the
same prompts, and accepts the same envelope and artifacts as for `claude`, with
no change to the scheduler, the `RuntimeAdapter` contract or the submission path.

## What is kind-specific today

Herdr 0.9.1 starts 24 kinds (`herdr agent`: pi, claude, codex, gemini, cursor,
opencode, grok, amp, droid, …). Woof admits one. The kind-specific surface in
Woof is small:

| Surface                   | Today                                                                                           | Where                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Launch arguments          | `--model`, `--add-dir <runDir>` for `claude`; every other kind refused `agent_kind_unsupported` | `src/scheduler/launch.ts`                             |
| Engine-owned flags        | One global list, `--model` and `--add-dir`, rejected in role files and workflow input           | `src/config/schema.ts`, `src/scheduler/admission.ts`  |
| Operator trust pre-flight | Claude folder trust, advisory warning                                                           | `src/runtime/claude/trust.ts`, `src/config/record.ts` |
| Permission-bypass warning | Claude flag names only                                                                          | `src/config/schema.ts`                                |
| Doctor                    | Probes `claude --version`; `claude_unavailable` is always a problem                             | `src/commands/doctor.ts`                              |

Prompt delivery, observation and stop go through `herdr agent` commands and do
not name a kind. Result submission is a shell command (`woof submit`) the agent
runs, so it needs only a shell tool.

## pi facts that shape the entry

- `--model <pattern>` selects the model (`provider/id`, optional `:<thinking>`).
  `--models` is a different flag (Ctrl+P cycling) and must not match.
- pi has no directory sandbox and no permission prompts: its tools reach any
  path the process can. The run directory needs no grant, and there is no
  bypass flag to warn about.
- Project trust: an interactive start asks a trust question only when the
  project has resources that need trust (`.pi/` settings, extensions, prompts)
  and no saved decision in `~/.pi/agent/trust.json` and `defaultProjectTrust`
  is `ask`. `--approve`/`--no-approve` override it for one run. This is a
  startup block of the same class as Claude folder trust.

## Proposed change

1. Make the kind table an explicit per-kind record: owned flags plus the engine
   arguments. `claude` keeps `--model` and `--add-dir`; `pi` owns `--model`
   only. Owned-flag rejection becomes per kind, and its messages name that
   kind's flags. An unlisted kind owns nothing and is still refused by
   `launchArgs`.
2. Woof never adds `--approve`. A role may set it; report it under the existing
   `permission_bypass_configured` warning, since it widens what loads without
   the operator's answer.
3. Doctor probes `pi --version` and reports it. An executable is a problem only
   when the resolved configuration uses that kind; `claude_unavailable` keeps
   its current meaning because the built-in roles are `claude`.
4. No pi trust pre-flight in this phase. A pi start that blocks on the trust
   question already ends through the bounded readiness limit. Record it as a
   known limit; add an advisory check only if live runs show it bites.

## Alternatives considered

- **Pass any Herdr kind through unchecked.** Smallest change, all 24 kinds at
  once. Rejected: each kind differs in model flag, write grant and startup
  questions; an unverified kind fails mid-run instead of at admission, which
  breaks "unsupported reports unsupported".
- **Kinds as configuration (a user-defined table of flags).** Flexible, no
  release per kind. Rejected for now: it makes launch flags a public contract
  before two kinds have shown what varies. Revisit after a third kind.
- **Per-kind table in code (chosen).** One reviewed entry per kind, admission
  stays strict. Cost: a release per kind. Falsified if the second and third
  entries need fields the record cannot express without special cases.

## Evidence this phase must produce

- Unit: `launchArgs` and owned-flag rejection for `claude` and `pi`, including
  `--models` not matching and an unlisted kind still refused.
- Process: admission accepts a `pi` role; a role file setting `--model` for
  `pi` is rejected; `--add-dir` in a `pi` role is not rejected by Woof.
- Live: `build-review` with a `pi` builder and a `claude` reviewer through
  Herdr, recorded like `docs/research/build-review-live.log`. If pi cannot be
  run live (no provider credentials), say so and leave the evidence limit open.

## Next kinds

`codex` and `grok` are installed on the development machine and are the likely
third and fourth entries. Both have a write sandbox (`--add-dir` for codex;
grok has no directory grant) and their own approval flags, so each needs its
own verification pass rather than a copy of this entry.
