# Composition live evidence

Live acceptance for [checkout policy and workflow composition](../design/composition.md),
recorded by `scripts/live/composition.mjs` in
[`docs/research/composition-live.log`](../research/composition-live.log) (home paths
shown as `~`).

Revision: `fe4b5bb` on `feat/composition` (the log's `woof commit`). Date: 2026-09-22.
Versions: node v26.7.0, git 2.51.2, herdr 0.9.1, claude 2.1.278. Result: **12/12 gates
passed**, exit 0, no `run.blocked`.

What ran: inside a Herdr pane, `woof run start --workflow auto-build` (herdr-pane host) on the
re-initialized fixture repository with `checkout: {"mode":"worktree"}`, `publish` of the plan
and `verify: node --test`, then a second `auto-build` cancelled with `woof run cancel` while its
planner worked. Three real Claude agents (planner, builder, reviewer; claude/sonnet with
`--permission-mode auto` from the fixture's roles) ran sequentially in two child runs.

| Gate | Claim                                                                                       | Evidence in the log                                                                 |
| ---- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | The launcher created a Herdr worktree on `woof/<runId>` and hosted the run in its root pane | host pane `w9N:p1`, Herdr `pane get` workspace `w9N` = checkout workspace           |
| 2    | `auto-build` completed: plan step, then build step                                          | parent `run.terminated completed built`, gates `plan:planned,build:built`           |
| 3    | Child runs are ordinary runs, listed by `woof runs` and linked both ways                    | `stage.child_opened`/`stage.child_result` ×2, `run.opened.parent`, `parent` entries |
| 4    | Every agent tab of both children opened in the worktree's workspace                         | 3 assignments, Herdr workspaces `["w9N","w9N","w9N"]` while open                    |
| 5    | The accepted `plan.md` flows by digest into build-review: input, run copy, every request    | plan sha256 `3acb38ff…`, `inputs/1/plan.md`, both requests carry the plan line      |
| 6    | The plan and the reviewed change are committed on the worktree branch; tests pass           | commits `Implement slugify`, `plan: Implement slugify`; clean tree; `node --test` 0 |
| 7    | Both children worked in the parent's checkout (`inherited`), none created one               | both `run.opened.checkout` inherited, path = the worktree                           |
| 8    | `foldEvents == readSnapshot` for the parent and both children                               | `[true,true,true]`                                                                  |
| 9    | The pure composite read `running` while its children ran                                    | 45 samples                                                                          |
| 10   | Cancelling a running `auto-build` cancels its plan child, which records why                 | parent `cancelled via woof run cancel`; child `cancelled`, `parent run ended`       |
| 11   | Woof's own worktree unchanged; the script never reads panes or sends keys                   | no hits                                                                             |
| 12   | The log records versions, inputs, commands, traces and artifacts                            | all recorded                                                                        |

Human inspection: the accepted plan is a real file-level plan for the task, and the review
(verdict `pass` on the first round) checks the committed change against the plan and the
acceptance criteria. The build went straight from review to completion, so this run did not
exercise a repair round; repairs with the plan input are covered offline
(`test/auto-build.cli.test.ts` B1). Both worktrees were removed afterwards with `herdr worktree
remove`; their branches stay in the fixture repository.

Operator precondition observed: the fixture repository was trusted in Claude Code; its Herdr
worktree under `~/.herdr/worktrees/fixture-repo/` started agents without a trust prompt.
