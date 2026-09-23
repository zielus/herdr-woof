# Configuration and project context

## Required behavior

Woof has reusable user-level defaults and project-local overrides. Projects can
version roles, workflow definitions and model preferences with their code.
Per-run instructions come from workflow input; role instruction/context files
are not supported. The SDK accepts resolved configuration; it does not depend on
Claude Code to resolve settings or on a host plugin being installed.

Precedence is project → user → built-in. Explicit per-run overrides are
validated, visible to the caller and recorded with the run. Resolution explains
which source supplied each effective role, workflow and setting.

Role, agent kind, provider and model are separate. For example, `reviewer` is a
project responsibility that can resolve to a supported coding-agent CLI, a
configured provider (for a kind that selects one) and a configured model. Model
and provider values are configuration, not a tested provider support matrix.

## Recommended layout

The implemented layout uses project `.woof/` and user `~/.woof/` directories.
See "Implemented now (p4)" below for the exact schemas, discovery rules and
precedence:

```text
~/.woof/
  woof.json
  roles/
  workflows/
  runs/
  index/

<project>/.woof/
  woof.json
  roles/
  workflows/
```

(`runs/` is a user-scope-only default: `woof.json`'s `runsDir` setting is
refused in a project file. `index/` is the run locator index, a fixed location
that `WOOF_INDEX_DIR` overrides and no settings file configures.)

Named roles and workflows use whole-definition replacement. Scalar defaults use
explicit field-level precedence; limits compose per key. There is no implicit
recursive merge of permission settings or workflow edges.

Do not invent project-local `.herdr/` semantics. Keep Woof project configuration
separate from Herdr's own installation, runtime and UI configuration. A plugin
adapter can map host-provided directories into explicit Woof configuration.

## Run resolution

At admission, resolve the project root and runtime target, discover the workflow,
validate its input, resolve every role, and validate limits and required
capabilities. Missing roles, invalid settings, or unavailable providers fail with
an explanation before workers are launched.

Capture the effective configuration and provenance with the run. Editing a role
file halfway through a review loop must not silently change the builder's model
or permissions. If a run intentionally changes configuration, record it as an
explicit operation.

Role instruction/context files are not a configuration surface. Keep shareable
project settings separate from private runtime credentials and generated run
artifacts.

Permission policy belongs to explicit role/project configuration. Woof does not
add `bypassPermissions` or dismiss trust dialogs. It represents a permission
block and exposes the required user action.

## Implemented now (p4)

Real shipped behavior for configuration files, discovery, resolution and
recording — not design intent. Source: `src/config/{schema,read,discover,
resolve,record,index}.ts`, `src/runtime/claude/trust.ts`, `woof config show`
(`src/commands/config.ts`).

- **Layout and schemas.** `<scope>/.woof/woof.json` (settings), one role per
  file `<scope>/.woof/roles/<name>.json`, and one workflow definition module
  per file `<scope>/.woof/workflows/<name>.{mjs,js,ts}` (stem = the name).
  Scopes are project (`<project root>/.woof`) and user (`~/.woof`), plus a
  built-in catalog: workflows `build-review` and `plan-build-review` (p5 D2 —
  a name-keyed, null-prototype registry, so adding a built-in workflow adds
  no branch to configuration resolution), and since composition `plan` and
  `auto-build`; roles `builder`/`reviewer`, plus
  `planner` (p5), a third built-in role a bare `plan-build-review` input
  resolves with no configuration at all.
  Every JSON file is an object with `schemaVersion: 1`, at most 64 KiB;
  unknown keys are refused (`config_invalid`, naming the file and a JSON
  pointer). `woof.json`'s `defaults` (all optional): `workflow` (an id),
  `limits` (a partial `Limits`, each key its p3 bounds), `pollMs`
  (1–3 600 000), `keepPanes`, `hostStartTimeoutMs` (1000–600 000), `runsDir`
  (an absolute path, **user scope only** — a project `woof.json` setting it is
  `setting_scope_invalid`). A role file: `kind` (required, non-empty), `model`
  (required: a string or `null`), `provider` (optional: a non-empty string or
  `null`; only a kind that selects a provider accepts one, else
  `role_invalid`), `args` (optional, default `[]`, must not set a flag the
  kind's engine owns, in split or `=`-joined form, nor an argument the kind
  refuses — `role_invalid`; see [Agent kinds](#agent-kinds)), `description`
  (optional, ≤ 500 characters). A kind with no spec keeps refusing `--model`
  and `--add-dir`. A malformed or unreadable file
  in a scope that applies fails admission even when its role is unused.
- **Discovery (D4).** The project root is `git rev-parse --show-toplevel` from
  `--project` (default the working directory); only `<root>/.woof` is read. A
  `.woof` found between the start directory and the root is ignored with
  warning `nested_config_ignored`, naming it. A worktree reads its own
  versioned `.woof` (git resolves its `.git` file). Not a git work tree: no
  project scope. A project `.woof` whose real path equals `~/.woof` is read
  once, as user scope. Tests pass `HOME`/`--project` as explicit options; no
  test reads the operator's real configuration.
- **Precedence (§3.3).** Roles and workflows are whole-definition replacement:
  workflow input override → project `roles/<role>.json` → user
  `roles/<role>.json` → built-in role, else `role_unresolved`; workflow name
  `--workflow` → project/user `defaults.workflow` → `build-review`. Settings
  follow a per-field table (flag → project → user → built-in default), and
  each `limits.<key>` composes per key: input → project → user → the
  workflow definition's own `limitDefaults[key]`. The losing layers for a
  winning value are listed in `shadowed`, never merged into it.
- **Provenance and `woof config show`.** `resolveConfiguration({projectDir,
homeDir, flags})` returns a `ResolvedConfiguration` (`schemaVersion: 1`,
  `kind: "woof.config.resolved"`): `roots`, `files` (every file read, with its
  sha256 and byte count), `workflow` (`Provenance<{name, version}>` — `version`
  is `null` for a file workflow, since `config show` never imports a
  non-built-in module), `roles` (every discovered/built-in role, each a
  `Provenance<RoleValue>`), `agents` (empty in `config show`; per-plan agent
  once a run is admitted), `settings` (`workflow`, a partial `limits` holding
  only the keys configuration or a definition's own defaults set, `pollMs`,
  `keepPanes`, `hostStartTimeoutMs`, `runsDir`, each a `Provenance<T>`),
  `repository` (`null` in `config show`; the admitted repository on a run),
  and `warnings`. Each `Provenance<T>` carries `value`, `source`
  (`"flag"|"input"|"project"|"user"|"builtin"`), `path` (`null` for
  flag/input/builtin), `sha256` and `shadowed`. `woof config show [--project
  <dir>] [--workflow <name>]` prints `{"outcome":"config","configuration"}`
  (exit 0) or `{"outcome":"rejected","reason","message","details",
  "configuration"?}` (exit 2, with a partial configuration once the roots
  resolved). It never imports a workflow module and takes no journal lock.
- **Refusals.** `config_invalid` (unknown key, wrong type, unreadable/
  oversized file, or — decided when the host loads a discovered workflow's
  module — a definition whose `name` differs from its file stem),
  `config_conflict` (two files with one stem in one scope, e.g.
  `build-review.ts` and `.mjs`), `setting_scope_invalid` (`runsDir` in a
  project file),
  `role_invalid` (a role's `args` sets an engine-owned flag), `role_unresolved`
  (admission only: no layer resolves a role the workflow uses),
  `project_mismatch` (admission only: the input's repository is not the
  resolved project root — the message names both paths and suggests
  `--project <repository>`), `workflow_not_found`. An unsupported role `kind`
  is only a warning (`role_kind_unsupported`) in `config show`, and fails
  admission (`agent_kind_unsupported`) only for a role the workflow actually
  resolves to.
- **A role or workflow name that collides with an `Object.prototype`
  member resolves cleanly, never as a phantom or a crash.** Role and
  workflow lookups are matched as own entries only (`Object.hasOwn`) against
  null-prototype built-in and per-scope dictionaries: `constructor.json` or
  `toString.json` resolve as ordinary project/user roles, and a workflow
  role named `constructor` or `toString` that nobody actually defines is
  `role_unresolved` at admission, same as any other undefined role.
  `--workflow constructor`/`toString` similarly resolves a project/user
  `workflows/constructor.mjs` when one exists, else `workflow_not_found` —
  never the inherited `Object.prototype` member misread as a phantom
  built-in layer, and never a `TypeError`. `__proto__` is refused earlier,
  by the existing id-format rule, before it ever reaches a lookup: a role or
  workflow file stemmed `__proto__` is `config_invalid` ("is not a valid
  id"), and `--workflow __proto__` is a CLI usage error (exit 1) for the
  same reason. The same own-property guard applies where a run's admitted
  agents are matched back against `configuration.roles` to build the
  recorded provenance in `config.json`: an input agent whose role is
  `constructor` or `toString`, with no such role actually configured,
  records cleanly as `{source:"input", path:null, sha256:null,
shadowed:[]}` rather than picking up `Object.prototype`'s own `constructor`/
  `toString` as a phantom shadowed layer (or throwing, before this was
  fixed).
- **Built-in roles and permission visibility.** `builder`/`planner`/`reviewer` default
  to `{kind:"claude", model:null, args:[]}`, `source:"builtin"` — the engine
  never adds a permission flag, so an interactive agent with no explicit
  permission configuration stops at its own prompt and the run records
  `run.blocked{reason:"startup_blocked"}`. Args that configure a permission
  bypass for the role's kind (see [Agent kinds](#agent-kinds); for `claude`
  `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
  `--permission-mode bypassPermissions`, split or `=`-joined) are allowed but
  produce warning `permission_bypass_configured`, naming the source, the kind
  and the flags, in `run start` output
  and `config.json` — only for the agents actually admitted, once per role
  file, and with no path when the workflow input itself set the bypass. A
  role-file bypass an input agent's safe args replaced, or one on a role the
  workflow does not use, is never reported in `config.json`/`run start`;
  `config show` (which resolves every role, not just the ones a run admits)
  still reports it against that role.
- **Recording.** `openRun`/`openAdmittedRun` write `<runDir>/config.json`
  (mode 0444) holding the resolved configuration completed with the admitted
  `agents`, per-key `settings.limits` (including input overrides),
  `repository`, and each admitted kind's trust warnings; `run.opened` gains an
  optional `config: {sha256, bytes}`, and the snapshot gains `config: {path, sha256,
bytes} | null`. Nothing after admission re-reads `.woof/`: editing a role
  file mid-run changes nothing about that run.
- **Claude Code trust (D10, advisory only).** `claudeTrustStatus(dir,
{homeDir})` reads `<home>/.claude.json` (16 MiB cap, a regular file opened
  `lstat` + `O_NOFOLLOW` with a device/inode match, never writes) and reports
  `trusted`, `untrusted`, or `unknown` (missing/unreadable/non-regular file,
  parse failure, no `projects` object). A symlinked `~/.claude.json` reports
  `unknown` rather than following it. It never rejects a run; `woof doctor
[--json]` and `run start`'s `warnings[]` report it, and `/woof:run` asks the
  user to resolve `untrusted`/`unknown` before continuing. The engine's own
  `startup_blocked` stays the authority.
- **`woof doctor`'s `trust.dir` is the git top level, exact-key.** `doctor`
  resolves `--repo` (or the working directory) to the git top level of that
  path — spelled as the ancestor of the given path that is that top level, so
  a symlinked spelling is kept, while the real path is also tried as a key —
  or that directory itself outside a git work tree. Trust is read for exactly
  that key; an ancestor's trust and a subdirectory's own key never count
  (D10's ancestor-trust rule is unchanged). Both `--json` and human-mode
  output now render the same report from the same probes (`herdr` and every
  admitted kind's CLI with `--version`, plus a kind's readiness probe for each
  resolved role of that kind); JSON gains an additive `problems: string[]`
  (`DoctorProblem` in `src/commands/doctor.ts`, not in the package index),
  populated in order from `herdr_unavailable`, `claude_unavailable`,
  `trust_untrusted`, `trust_unknown`, `config_invalid`, then, for each kind
  other than `claude` that a resolved role uses, `<kind>_unavailable`,
  `<kind>_not_ready` and `<kind>_trust_untrusted`/`<kind>_trust_unknown`. The
  additive `kinds` array lists every admitted kind with its probe, the
  resolved roles using it, their readiness probes and its trust warning. Every
  probe is killed at 10 s; a kind runs at most 4 readiness probes, together,
  and lists further selections with `ready: null` ("not probed"), which is not
  a problem. The `claude` problems stay unconditional. `--strict` exits 2 when `problems` is
  non-empty, in both modes; without it `doctor` still always exits 0.
- **Non-goals.** Role instructions and context
  files are not part of configuration — per-run `instructions` stays in the
  input, and the role file schema reserves no such key. A per-run `.herdr/`
  layer, TOML/YAML, and TypeScript config modules that execute at every
  `config show` are not implemented, by design.

## Agent kinds

Each admitted kind has one spec module under `src/runtime/kinds/`, verified
against the CLI installed on the development machine (versions below). Herdr
starts every kind with `herdr agent start --kind <kind>` and reports its
lifecycle through its own hook integration (`herdr integration status`); Woof
adds no kind-specific observation, prompt delivery or result path. The engine
adds only the model, a provider where the kind selects one, and a run-directory
grant where the kind confines writes; it never adds a permission flag.

| Kind     | Verified against | Engine adds                                             | Engine owns                               | Refused at admission                                                 | Reported as a bypass                                                                                                                        | Trust pre-flight             | Doctor readiness                                         |
| -------- | ---------------- | ------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| `claude` | Claude Code 2.1  | `--model`, `--add-dir <runDir>`                         | `--model`, `--add-dir`                    | —                                                                    | `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions`                             | `~/.claude.json` (exact key) | —                                                        |
| `pi`     | pi 0.86.0        | `--provider`, `--model` (no grant: pi confines nothing) | `--model`, `--provider` (not `--models`)  | `--add-dir` (pi has none)                                            | `--approve`, `-a`                                                                                                                           | `~/.pi/agent/trust.json`     | `pi auth check --provider/--model … --json --no-refresh` |
| `codex`  | codex-cli 0.156  | `--model`, `--add-dir <runDir>`                         | `--model`, `-m`, `--add-dir`, `-c model=` | `read-only` sandbox, `-C`/`--cd`, `--worktree`                       | `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--approve-for-me`, `--dangerously-bypass-hook-trust`, `danger-full-access` sandbox | none                         | `codex login status`                                     |
| `grok`   | grok 1.0.41      | `--model` (no grant exists; default sandbox is off)     | `--model`, `-m`                           | `read-only`/`strict`/`workspace` sandbox, `-w`/`--worktree`, `--cwd` | `--always-approve`, `--permission-mode bypassPermissions`, `--dangerously-skip-permissions`, `--trust`                                      | none                         | none (`--version` only)                                  |

- **Provider.** Only `pi` selects a provider (`--provider`, for example
  `github-copilot`); a role's `provider` is refused, never dropped, for any
  other kind. The provider is shown by `config show`, recorded in `config.json`
  with the role's provenance and passed in the launch arguments; the journal's
  plan records it only through those arguments. Nothing defaults to a vendor:
  without `provider` and `model`, the CLI's own defaults apply.
- **Startup questions.** An unanswered folder-trust, hook-review or permission
  question at startup ends as `run.blocked{reason:"startup_blocked"}` when Herdr
  reports the agent blocked, or `agent_start_failed` when the start times out.
  The `claude` and `pi` pre-flights are advisory warnings
  (`<kind>_trust_untrusted`/`<kind>_trust_unknown`) and never reject a run.
  pi asks only when the checkout has trust-requiring resources (`.pi/`
  settings, extensions, skills, prompts, themes, system prompts, or a project
  `.agents/skills`) and no saved decision applies. codex asks to trust a
  project its `config.toml` does not trust and to review new or changed hooks,
  Herdr's state hook included; grok asks to trust a folder its
  `trusted_folders.toml` does not. Woof does not pre-check codex or grok.
- **Request note.** `codex` and `grok` requests end with one fixed sentence
  about their sandbox and the run directory; the admission-time request bound
  reserves room for the longest such note.
- **Known limits.** `codex` and `grok` have no live acceptance run. A pi model
  id unknown to its provider starts and then fails on its first turn; `pi auth
check` does not validate the model, and it runs only for a role with a
  `provider` or a `provider/id` model: pi reads an unqualified `--model` there
  as a provider name and answers `invalid`. grok's built-in `read-only`,
  `strict` and `workspace` sandboxes cannot write a run directory outside the
  working directory, `~/.grok` and temp dirs; Woof refuses them in the
  arguments, but not a custom profile or a sandbox set by `GROK_SANDBOX` or
  grok's config.
  Model or permission overrides in a CLI's own config or profile (`codex
--profile`, grok `permission_mode`) are not visible to Woof.
- **Not admitted.** Other Herdr kinds, including the standalone `copilot` CLI,
  are refused with `agent_kind_unsupported` until they have a spec and
  evidence.

## Decisions still needed

Artifact retention, a per-attempt result-wait limit (deferred: today's
`runTimeoutMs` plus `woof status`'s per-attempt `dispatchedAt` make a stuck
worker visible and boundable), and Woof-level ignore globs for the revision
fingerprint (documented instead as a `.gitignore` requirement on verify
outputs — see [initial workflows](../workflows/initial-workflows.md)) stay
open. Root discovery, role serialization, the configuration schema/
versioning, run storage location and per-run override rules are resolved by
"Implemented now (p4)" above.

See [acceptance criteria](../acceptance/v1.md) for precedence tests.
