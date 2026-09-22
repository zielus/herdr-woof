# woof tui acceptance evidence

Branch `feat/tui`, recorded 2026-09-22 against the checks in
[Terminal UI › Acceptance](../design/tui.md#acceptance). Versions: node v26.7.0,
bun 1.3.2, herdr 0.9.x on macOS.

## What was exercised, and how

**Real terminal.** `woof tui` ran in a real Herdr pane, split to the right of the
builder's pane. Keys went in as raw terminal input through
`herdr pane send-keys` and `send-text`, and the screen was read back with
`herdr pane read` (text and ANSI). The pane started at 78x61 and was then
really resized to 79x23 by splitting it: the terminal delivered the size
change, so this was not a simulated SIGWINCH.

**Run data.** No agents were started for this acceptance. The runs are real
build-review runs recorded on 2026-09-21 and 2026-09-22 under
`~/.herdr-dev/runs/herdr-woof/p3-build-review-loop/live/`, copied read-only
into a scratch runs directory. For live behaviour, a small replayer re-appended
one completed run's `journal.jsonl` into a fresh run directory, one record every
0.5–1.2 s, while the TUI followed it. The journal bytes, artifacts and saved
input are the original run's. Elapsed times therefore count from the original
timestamps (hours), which is the truthful reading of that journal. A lost host
was produced by giving a replayed run a `host.json` claim with a dead pid and a
stale heartbeat, which the engine's host probe reports as `lost`.

## Checks

| Design acceptance item                                                                                                              | Result | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browse runs, open one, expand a review, select its artifact, return to the same tree entry and runs-list position by keyboard alone | pass   | In the pane: Down, Enter opened `Implement slugify`; Down Down Right expanded `review` (`changes requested`); Right selected `›review.md`; Right opened the pager; PgDn scrolled (`lines 10-19 of 53`); Esc returned to `›review.md` with `review` still expanded; Left Left Esc returned to the runs list with the same run under `›`.                                                                                                                                                                                                                                                                                          |
| Right enters the tree, Left backs out or collapses; Up/Down visit only visible entries                                              | pass   | As above, in the pane. The same bindings are covered table-driven in `test/unit/tui-state.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Steps, Activity and Config use the content area; details expand inline; the pager replaces content and Esc restores the origin      | pass   | Pane reads of each tab and of the pager. The header stayed visible over the pager.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Earlier reviews, repeated checks, attempts and repair continuity stay unambiguous; history never overwrites current status          | pass   | Steps showed `review` (`changes requested`), `repair`, `verify 2`, `review 2` (`approved`). The first review's artifact context reads `verdict fail · gate: changes requested → repair`, and its handoff line reads `accepted review → builder (same agent)`. The header kept `completed · review 2` while review 1 was expanded.                                                                                                                                                                                                                                                                                                |
| Activity explains startup, dispatch, waiting and gate routing; new observations do not interrupt reading or move focus              | pass   | While the journal replayed, Up paused Activity at `lines 4-18`. Six seconds later the viewport was unchanged and the status line read `paused · lines 4-18 of 30 · 10 new · end returns to latest`. End jumped to the latest row and to `✓ recorded outcome: completed · approved`.                                                                                                                                                                                                                                                                                                                                              |
| Config shows agent models, readable input and resolved context; unknown values stay explicit                                        | pass   | `--frames` dump and pane: roster (`builder claude sonnet build, repair`), recorded assignment and lifecycle, pretty-printed input with explicit abbreviation (`… (47 more characters)`), full input path, and context with project, repository, revision, run, workflow, verify command, limits and provenance.                                                                                                                                                                                                                                                                                                                  |
| Empty history, unavailable files, long content, no color, narrow/short terminals and observation loss stay usable and truthful      | pass   | Empty and missing runs directories give distinct messages. The pager's missing, binary and truncated states are covered in `test/unit/tui-artifact.test.ts` and `test/tui.cli.test.ts`. Long request files pan with Left/Right. With `NO_COLOR=1` the pane's ANSI read held 0 color SGRs (21 with colour on) and kept 3 reverse-video spans for selection. A 50x16 ASCII `--frames` dump stays aligned. Below 40x10 the TUI shows an explicit message. Lost host: header `host lost`, `outcome unknown · no terminal outcome recorded`, the accepted but ungated review reads `accepted · no gate`, and nothing reads as failed. |
| Real keyboard operation, scrolling, resize, live updates and reconnect in a terminal                                                | pass   | All of the above were in a real pane. Resize: the frame re-laid out at 79 columns after the real split. Reconnect: the journal was moved away mid-run for 2 s. The header showed `reconnecting` and `cannot re-read the run: run_dir_invalid …`, then recovered to `history · completed`. The Activity rows then equalled a fresh read of the finished run (29 rows, 29 unique, identical set), so no rows were duplicated or lost.                                                                                                                                                                                              |

## Found and fixed during live acceptance

- Each row ended with erase-to-end-of-line. In the real pane that erased the
  last column, because after a full-width row the cursor sits in the
  pending-wrap state. Rows are now padded to full width with no EL (commit
  `0f81b39`).
- The "next" hint followed a review's rejection edge. It now shows the routed
  stage as `next · changes requested` and stops at a step that can complete
  the run (commit `5a6fb66`).

## Not established here

- A run driven by live agents, rather than a replayed journal, was not observed
  in this session. The brief did not allow starting agents.
- Blocked runs were checked through unit fixtures (`test/unit/tui-model.test.ts`),
  not a live blocked agent.
- In Herdr's terminal, leaving the alternate screen left the last frame visible
  above the shell prompt. The TUI writes the standard sequence (`CSI ?1049l`,
  with the cursor shown again), and the PTY test checks for it.
