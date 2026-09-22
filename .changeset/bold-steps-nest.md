---
"herdr-woof": minor
---

A workflow can be a step: workflow definitions may run other workflows as child runs.

A stage `{kind: "workflow", stageId, workflow: {name}, input(ctx), next(ctx)}`
runs the named workflow (project, user or built-in) as a child run hosted by the
same process, in the parent's checkout. `input(ctx)` maps the parent's input and
earlier steps' results (`ctx.history.children`) to the child's input; `next`
routes on the child's outcome. The child is an ordinary run next to its parent
(`<parent>.<stage>.<visit>`, with `run.opened.parent`), and the parent journals
`stage.child_opened` and `stage.child_result`, accepting the child's `RunResult`
as the step's `result.json` together with copies of the child's accepted
artifacts, which later stages can take as inputs (`{from: {stageId, artifact}}`).
Cancelling the parent cancels the running child; the parent's visit, round and
time limits bound its steps. Definitions may also declare `inputArtifacts` whose
digests admission checks and the run copies in (`{from: {input: label}}`).
`woof runs`, `woof status`, the run view, events and snapshots show both runs
and their link; all additions are additive at schemaVersion 1.
