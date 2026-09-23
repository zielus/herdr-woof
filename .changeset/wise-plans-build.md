---
"herdr-woof": minor
---

Two built-in workflows: `plan` and the composite `auto-build`.

`plan` runs one planner that writes `plan.md`; with `publish: {path, push?}` the
planner also commits the plan at that repository path (and pushes), and an
engine-run check confirms the commit before the run completes. `auto-build`
has no agents of its own: it runs `plan` and then `build-review` as two child
runs in the same checkout, mapping its input to each and handing the accepted
`plan.md` to the builder and reviewer as a digest-checked input artifact. Its
input is `plan-build-review`'s plus `publish`, and both children's inputs are
validated before any step runs. `build-review` accepts `inputs: [{label, path,
sha256}]`, files every request names by path and digest after the run copies
them in. A run whose steps are all workflows reads as `running` while a child
runs.
