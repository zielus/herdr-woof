# A second agent kind: pi

Status: implemented in p8a, 2026-09-20. Based on source at `38b44b5` (Woof
0.2.0), Herdr 0.9.1 and pi 0.86.0 (`@earendil-works/pi-coding-agent`). Flags
below were read from `pi --help` and pi's bundled `README.md`, `docs/security.md`
and `dist/core/trust-manager.js` on the development machine; re-check them
against the installed version before relying on them.

This document is both the design and the record of what shipped. "What is
kind-specific today" describes the state before the change; "What shipped"
replaces the proposal; "Known limits" is the part a reader acting on this needs
most.

## Goal

A role may set `kind: "pi"`. Woof starts that agent through Herdr, delivers the
same prompts, and accepts the same envelope and artifacts as for `claude`, with
no change to the scheduler, the `RuntimeAdapter` contract or the submission path.

## What was kind-specific before p8a

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
- **`--model` is not restricted to `enabledModels`.** `enabledModels` in
  `~/.pi/agent/settings.json` scopes the interactive picker and `--models`
  cycling; `--model` accepts any model in the catalogue. Verified by running a
  model absent from `enabledModels` successfully. Always write the model
  `provider/id`, never the bare `defaultModel`, which drifts with that file.
- **A wrong model fails fast or slow depending on which half is wrong.** An
  unknown _provider_ (`nosuchprovider/foo`) makes pi print an error and exit, so
  `herdr agent start` never detects the agent and Woof reports
  `agent_start_failed`. An unknown _id_ under a known provider warns, then
  starts, and dies on its first API call (HTTP 400), so Woof sees a normal
  startup and then an exhausted delivery or readiness limit with nothing naming
  the model. There is no Woof-side fix in scope; see Known limits.
- pi has no directory sandbox and no permission prompts: its tools read, write,
  edit and run shell commands with the pi process's permissions. The run
  directory needs no grant.
- Project trust: an interactive start asks a trust question only when the
  project has resources that need trust (`.pi/` settings, extensions, prompts),
  there is no saved decision in `~/.pi/agent/trust.json`, and
  `defaultProjectTrust` is `ask`. `--approve`/`-a` and `--no-approve`/`-na`
  override it for one run. This is a startup block of the same class as Claude
  folder trust.
- **The user-global `~/.agents/skills` directory is excluded from that scan.**
  pi's `hasTrustRequiringProjectResources` treats it as an always-trusted user
  resource and ignores it, even when the working directory is `$HOME`. That is
  why a fixture repository with no `.pi/` of its own reaches no trust question
  on a machine that has `~/.agents/skills` — the behaviour is not stated in
  pi's `docs/security.md` prose, so it is recorded here.

## What shipped

1. The kind table is an explicit per-kind record: owned flags plus the engine
   arguments. `claude` keeps `--model` and `--add-dir`; `pi` owns `--model`
   only and never receives a run-directory grant. Owned-flag rejection is per
   kind and its messages name that kind's flags. An unlisted kind owns nothing
   and is still refused by `launchArgs`.
2. Woof never adds `--approve`. A role may set it; it is reported under the
   existing `permission_bypass_configured` warning, since it widens what pi
   loads without the operator's answer. `--approve` and `-a` match by equality,
   so `--no-approve` and `-na` do not warn, and the kinds' flags do not cross.
   The warning code is unchanged — `config.json` readers depend on it — but its
   message now names the kind and the flag, so a reader is not told pi bypasses
   a permission prompt it never had.
3. `woof doctor` probes `pi --version` and always reports it. A missing pi is a
   problem (`pi_unavailable`) only when some resolved role has `kind: "pi"`;
   doctor has no run input, so any resolved role counts, including a custom one.
   **`claude_unavailable` stays unconditional.** The earlier draft of this item
   justified that by saying the built-in roles are `claude`, which is not a
   sufficient reason: built-in roles are the _bottom layer_ of resolution, so a
   project defining `.woof/roles/{builder,planner,reviewer}.json` with
   `kind: "pi"` shadows all three and leaves no resolved `claude` role. Gating
   claude the same way would therefore silently stop `claude_unavailable`
   firing for such a project, weakening a documented `--strict` contract this
   phase did not set out to change.
4. No pi trust pre-flight, and no `pi` analogue of `src/runtime/claude/trust.ts`.
   A pi start that blocks on the trust question ends through the bounded
   readiness limit. See Known limits.
5. No scheduler, `RuntimeAdapter` or submission change, and no third kind.
   `codex` and `grok` stay unsupported.

## Known limits

These are real and unfixed. They are the cost of keeping admission strict
without a per-kind rejected-flag allowlist, which is the "kinds as
configuration" alternative this document rejects.

- **A pi role setting `--add-dir` starts and then fails.** `--add-dir` is not
  engine-owned for `pi`, so Woof accepts it and passes it through, and pi has no
  such flag. Woof sees an exhausted limit rather than a clean rejection. Pinned
  by a process test so the behaviour cannot change silently.
- **A wrong pi model can fail slow.** An unknown id under a known provider
  starts and then fails on its first turn, surfacing as a delivery or readiness
  exhaustion with nothing in Woof's output naming the model. Only an unknown
  provider fails at start.
- **pi's trust question can still fire.** The finding above is
  machine-specific: it holds because the fixture has no `.pi/` and the only
  `.agents/skills` is the excluded user one. A project that carries `.pi/`
  blocks a pi start, and Woof reports it only as an exhausted readiness limit.

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

## Evidence

- Unit: `launchArgs` and owned-flag rejection for `claude` and `pi`, including
  `--models` not matching and an unlisted kind still refused —
  `test/unit/launch-kinds.test.ts`. Per-kind bypass detection —
  `test/unit/config-resolve.test.ts`.
- Process: admission accepts a `pi` role; a role file setting `--model` for
  `pi` is rejected naming `--model` alone; `--add-dir` in a `pi` role is not
  rejected by Woof — `test/config.process.test.ts` (K1–K5).
  `woof agent start` with a pi role — `test/agent-start.cli.test.ts`. Doctor's
  probe and its gating — `test/doctor.process.test.ts`.
- Live: `scripts/live/pi-build-review.mjs`, a sibling of `build-review.mjs`
  with its own phase directory and fixture (that script's LV-101 incident is why
  it is not a flag on it). `--probe` starts one pi agent through
  `herdr agent start --kind pi` and has it complete one `woof submit`
  round-trip; the full run is `build-review` with a pi builder and a claude
  reviewer, recorded to `docs/research/pi-build-review-live.log`.

## Next kinds

`codex` and `grok` are installed on the development machine and are the likely
third and fourth entries. Both have a write sandbox (`--add-dir` for codex;
grok has no directory grant) and their own approval flags, so each needs its
own verification pass rather than a copy of this entry.
