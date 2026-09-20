---
"herdr-woof": minor
---

pi is now a supported agent kind alongside claude.

A role file or a workflow input agent may set `kind: "pi"`. The engine's launch
flags are per kind: claude still gets `--model` and `--add-dir`, while pi gets
`--model` only, because pi has no directory sandbox and needs no grant on the
run directory. Write a pi model as `provider/id`, for example
`openai-codex/gpt-5.6-sol`. Built-in roles are unchanged and still claude.

Because the owned flags are per kind, the rejection you get for setting one
names only that kind's flags: a pi role setting `--model` is rejected for
`--model` alone. The flip side is that `--add-dir` in a pi role is no longer
rejected by Woof; it is passed through to pi, which has no such flag, so the
agent starts and then fails on its own.

`woof doctor` now probes `pi --version` and reports it beside claude, in
`--json`, in the text report and in `herdr doctor`. A missing pi is a problem
(`pi_unavailable`, so `--strict` exits 2) only when some resolved role selects
pi. A missing claude is still always a problem.

pi's `--approve` / `-a` is reported under the existing
`permission_bypass_configured` warning and never added by Woof. `--no-approve`
and `-na` do not warn. The warning code is unchanged, so anything reading
`config.json` keeps working, but its message now names the kind and the flag it
saw: pi's flag trusts project-local files for that run rather than skipping a
permission prompt.
