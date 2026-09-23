---
"herdr-woof": minor
---

Agent kinds: roles and workflow input agents can now use `pi`, `codex` and `grok`
besides `claude`. Each kind is a small spec under `src/runtime/kinds/` that maps the
role onto that CLI's flags; Herdr starts every kind and reports its lifecycle.

- Roles gain an optional `provider`. `pi` maps it to `--provider` (for example
  `github-copilot`), and any other kind refuses it. It is shown by `config show` and
  recorded in `config.json` with the role's provenance.
- `codex` gets an `--add-dir` grant for the run directory. `pi` and `grok` get none,
  because they do not confine writes. Arguments a run could not work with are refused
  at admission: pi's `--add-dir`, codex's read-only sandbox, `-C` and `--worktree`, and
  grok's read-only/strict sandbox, `--worktree` and `--cwd`.
- Each kind's own permission-bypass flags are reported as `permission_bypass_configured`,
  and the warning now names the kind and the flags. pi gains an advisory
  `pi_trust_untrusted`/`pi_trust_unknown` pre-flight.
- `woof doctor` probes every kind's CLI in parallel. For a pi role it runs
  `pi auth check --no-refresh`, and for a codex role `codex login status`. Problems
  for kinds other than claude count only when a resolved role uses that kind. The
  JSON report gains `kinds`.
- `codex` and `grok` work requests end with a short sandbox note. The admission-time
  request bound reserves room for it, so the largest accepted `task` context is 171
  bytes smaller.
