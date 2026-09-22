# Woof terminal UI

Status: approved design direction, awaiting implementation.

This brief describes an interactive terminal UI for browsing runs and inspecting
one run in detail. It is a product and design handoff for the builder. Terminal
libraries, module boundaries and API details are implementation decisions.

The TUI extends the visual language of
[Human-readable run output](run-output.md): meaningful participant names, plain
English messages, restrained colors and a clear distinction between work,
review decisions and recorded outcomes. The append-only run output remains useful
for logs, redirection and users who do not need an interactive view.

## Visual reference

Open the [standalone interactive prototype](assets/tui/prototype.html) in a local
browser. The [editable source fragment](assets/tui/woof-tui.fragment.html) is also
included. These are design references, not production frontend code or a choice
of TUI framework. The standalone prototype does not require Codex to navigate
between runs, steps, input and artifacts.

The prototype uses sample runs. It makes no runtime calls and controls no agents.
Its task names, durations, branches, activity and artifact paths are illustrative.
The design includes running, blocked, completed, exhausted and lost-host examples.
The initial screen is the runs browser; opening a row reveals the run workspace.

Screenshot capture was blocked by an unavailable browser policy check when this
handoff was prepared. No screenshot or browser visual acceptance is claimed.
Use the interactive reference for layout review.

## Intent

A developer should be able to answer these questions without reading raw events:

- Which runs are active, finished or need attention?
- Which agent is involved, on which step, and what is the run waiting for?
- Why did a gate choose repair or another review?
- Where are the accepted outputs and the input that started the run?

Opening a run should change the workspace and give that run room. Avoid squeezing
its entire history into a small preview next to a permanent runs sidebar.

## Screen 1: runs browser

Use a list with a selected-run preview beside it on wide terminals.

Each row shows a human-readable task title, workflow, checkout or branch, start
time, state, current step and duration when known. Make state readable through
both a word and a marker. Internal IDs remain available but should not dominate
the list. When a task title is unavailable, use a truthful workflow/run label.

The preview shows the selected run's current situation, participants and models,
checkout context, and an open action. Moving selection updates the preview;
opening the run navigates to its workspace. Preserve list selection and position
when returning from a run.

Show unfinished runs and recent completed history. Keep blocked and lost-host
runs easy to find, while distinguishing those states from terminal failures.
Updates must not unexpectedly move selection to a different run. A missing or
unreadable runs directory needs an explicit empty or error state.

The prototype uses one project. Project scope should be visible; do not silently
mix checkouts that have similar directory or branch names. Broader search,
filtering and cross-project navigation can be separate work.

## Screen 2: run workspace

Replace the runs browser with a focused run view. Keep a short breadcrumb back
to the list and make switching to the previous or next run inexpensive.

### Persistent header

Show the task title, workflow, run identity, checkout, current run state, elapsed
time and host status. This header always describes the current run, even while
an earlier step or artifact is selected.

A blocked run gets a prominent reason and concrete required action. A lost host
gets an explicit unknown-outcome message. Completed runs show their recorded
outcome rather than an active-state indicator.

### Left: workflow steps

Show the ordered stage visits, including verification and repair. A repeated
review is a distinct visit, not an overwritten entry. Include each step's owner
or check identity and a concise status mark.

Provide an all-activity selection as well as individual steps. Selecting a step
filters the central activity and reveals that step's context on the right.
Selection styling must be distinct from lifecycle styling: inspecting review 1
must not make review 1 look active while the builder is repairing.

Expected future steps may be shown as pending only when their conditional nature
is clear. A workflow can reject, branch or repeat; do not present its route as a
fixed completion checklist or imply a percentage complete.

### Center: activity, input and artifacts

The central pane gets the largest share of width. It has three sections:

- **Activity:** human-readable chronological messages for all stages or the
  selected visit. Retain time, participant, meaningful action and gate routing.
  Reuse the message semantics from the run-output brief.
- **Input:** a readable, read-only structured preview. Large content is clearly
  abbreviated and accompanied by the full saved input's path.
- **Artifacts:** accepted outputs and verification evidence, with stage/visit,
  acceptance or verdict context, and a copyable path. Label earlier reviews so
  they cannot be mistaken for approval of the final revision.

Selecting an artifact shows its reference and context in the inspector. The
prototype does not implement a file viewer or launch an external application.
The initial TUI can keep references copyable and use existing supported file
opening integrations; a generic editor or diff viewer is outside this design.

Following a run should keep recent activity visible until the user deliberately
inspects older history. Scrolling back must not snap to the end on every event.
Show whether following is paused, preserve reading position, and offer an
explicit way to return to the latest activity. This behavior is a requirement
for the real TUI; the prototype's sample timeline is static.

### Right: agents and selected context

Keep a compact roster visible: agent name, role when different, provider/CLI
kind, configured model and its relevant assignment or last known state.
Distinguish runtime observation from submission history. A recorded submission
is not a claim that the agent is still running. A missing configured model
should remain `provider default` or unknown rather than being guessed.

Below the roster, show context for the selected step or artifact. With no step
selected, summarize the current run situation. Useful context includes a gate's
reason, the next route, the accepted review reference, and relevant run limits.

For example, selecting the first rejected review should show why the gate routed
to repair and the accepted review path, while the header still identifies the
current repair and its builder. Repair continuity must remain visible.

## Navigation

All essential actions must work from the keyboard. Mouse interaction is optional.
The prototype uses these bindings as a starting point:

| Key                | Behavior                                                                        |
| ------------------ | ------------------------------------------------------------------------------- |
| Up / Down or j / k | Move through runs or workflow steps in the relevant navigation context.         |
| Enter              | Open the selected run or activate the focused item.                             |
| Esc                | Close local help/detail first, then return from a run to the runs browser.      |
| [ / ]              | Switch to the previous or next run while keeping the run workspace open.        |
| 1 / 2 / 3          | Select activity, input or artifacts.                                            |
| Tab                | Move focus between available controls or panes, with a visible focus indicator. |
| ?                  | Show context-sensitive navigation help.                                         |

The footer should show the few shortcuts relevant to the current screen. Keep
focus distinct from selection. Arrow keys inside the activity pane should scroll
activity rather than unexpectedly selecting a different run or step. Exact
bindings may change to fit terminal conventions, provided the behavior stays
predictable and discoverable.

Leaving the TUI, returning to the list or switching runs only stops or changes
observation. None of those actions cancels the workflow. A quit action must make
this distinction clear. Cancellation, if included, should be a separate explicit
action with the run identity visible and protection against an accidental keypress.

## Layout and visual language

Use terminal-native typography, restrained separators and compact spacing. Keep
the palette aligned with the run-output design: cyan for active work or dispatch,
green for successful acceptance and completion, amber for repair or recoverable
attention, red for failure or unavailable ownership, and subdued text for context.
Symbols and words must preserve meaning without color.

The wide run view has three regions: steps, activity and context. As width
shrinks, move steps into a compact strip and reduce secondary metadata. At narrow
terminal widths, use focused panes or section switching rather than squeezing
three unreadable columns together. The prototype stacks content at narrow browser
widths to remain inspectable; that is not a requirement to vertically stack every
pane in the production TUI.

At roughly 80 columns, current state, participant identity and the selected
content must remain readable. At wider sizes, show the full workspace. Handle
limited terminal height with independent scrolling and a persistent header and
footer. Resizing must preserve selection and reading position. Long titles,
paths and model names must wrap or truncate with a way to inspect the full value.

## State and scope boundaries

The TUI consumes the same engine-owned observation and control contracts as
other interfaces. It does not infer state from agent prose, terminal output or
gaps between events. The UI must remain usable without plugin UI or MCP.

Keep accepted submissions, gate decisions and recorded run completion distinct.
Do not imply that a recommended approval is final, an idle agent succeeded, or
a lost host can resume. Distinguish work retry, format repair and code repair.
Duplicate or late observations must not create duplicate narrative history.

Display live, stale, disconnected and completed observation states honestly.
An observer timeout or disconnection is not a terminal run outcome. On reconnect,
recover a consistent visible state without silently losing the selection or
replaying duplicate rows. Unknown or missing data gets an explicit presentation.

Some desired waiting and activity details still need to be exposed consistently
by the engine. That work belongs in the shared observation contracts, not in a
parallel scheduler hidden inside the TUI. The builder should choose the smallest
supported changes needed to present those details truthfully.

This design does not add workflow creation, prompt editing, retry/resume/re-host,
permission approval inside Woof, agent terminal emulation, or a general-purpose
artifact editor. For a blocked agent, show where the user should act and use
supported Herdr integration only when available. Do not present an unsupported
action as an enabled control.

## Acceptance

- A user can browse runs, open one, inspect an earlier step and return to the
  same list position entirely from the keyboard.
- Opening a run produces a focused workspace rather than a longer list row.
- Selecting historical review or verification never overwrites the current run
  status in the header. The selected visit is unambiguous.
- Activity, input and accepted artifact references are reachable without losing
  the run context. Switching runs preserves the section where practical but
  clears any selection that belongs to a different run.
- Running, blocked, completed, failed/exhausted, cancelled and lost-host states
  remain distinct. Required action and outcome uncertainty are explicit.
- New activity does not steal focus, reorder the selected run away from the user,
  or interrupt someone reading history. Returning to the latest activity is clear.
- Empty lists, unreadable history, missing models, long labels, large input,
  narrow terminals, short terminals and no-color output remain usable.
- Closing or leaving the TUI leaves the run running. Any cancellation is a
  separate, clearly targeted action.
- Verify layout and keyboard behavior in a real terminal, including resize and
  reconnect, as well as automated behavior checks. Sample-data mockups alone do
  not establish live acceptance.

Related documents: [run output](run-output.md),
[observability](../architecture/observability.md),
[domain model](../architecture/domain-model.md), and
[Web UI capabilities](../architecture/web-ui.md).
