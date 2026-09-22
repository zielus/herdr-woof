---
"herdr-woof": minor
---

`woof watch` now tells the run's story in plain English.

By default it prints an opening block (workflow, repository and branch, run id
and directory, the agent roster with kind, model and stages, the stage map with
its gates and repair routes, the resolved limits and a preview of the input),
then one history row per meaningful fact — `HH:MM:SS  mark  participant  stage
message`, with `gate` and `run` as participants beside the agents — and, when
the run ends, an outcome summary with duration, review and repair counts and the
accepted artifact paths relative to the run directory. `--input json` shows the
input as indented JSON, cut with an explicit marker; `--ascii` (or a locale
without UTF-8) uses `+ -> v ~ ! .` for the marks; `--plain` keeps the technical
view (status header and one line per journal event), which `woof events
--pretty` still prints. Stopping the observer prints `-- observer stopped
(<reason>); the run continues`, distinct from the run's end. The renderer is
exported as `createRunRenderer` so a run host can print the same lines from the
same facts.
