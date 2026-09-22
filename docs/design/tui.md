# Woof terminal UI

Status: approved design direction, implemented as `woof tui`.

This is a product and design handoff for an interactive terminal run browser.
The reference is a terminal-native layout: aligned text, a selection cursor,
inline disclosure and a read-only pager. Frameworks, modules and API details
remain builder decisions.

The TUI extends [Human-readable run output](run-output.md): participant names,
plain English messages and clear distinctions between accepted work, gate
decisions and recorded outcomes. Append-only output remains useful for logs,
redirection and observing a run without an interactive interface.

## Reference and scope

Open the [standalone interactive prototype](assets/tui/prototype.html) in a local
browser. Its [editable source](assets/tui/woof-tui.fragment.html) is included.
This replaces the earlier three-column proposal and the subsequent card-like
step details. The approved direction uses one content area with Steps, Activity
and Config tabs. Runs use a compact list; artifacts replace the content area
with a pager.

The prototype contains sample running, blocked, completed and lost-host runs.
It makes no runtime calls and controls no agents. It opens on an expanded review
to demonstrate the design; Esc opens the runs browser. Click a control or focus
one with Tab before using keyboard navigation in the browser.

Implemented in the reference: run selection, tab switching, step expansion,
arrow navigation through steps and artifact entries, and sample artifact reading.
Live updates, history following, long-content paging, reconnect and real terminal
resize behavior are production requirements, not demonstrated runtime features.
Browser visual verification was blocked by an unavailable browser policy check;
no screenshot or real-terminal acceptance is claimed.

## Runs

Start with a full-width list of runs in the current project. Each compact row
shows state, task title, workflow, current step and elapsed time when known.
Use reverse video and a cursor to mark selection. Keep status words readable
without color. A missing task title falls back to a truthful workflow/run label.

Show active runs and recent history, including runs needing attention. Opening a
run replaces the list with that run's view. Returning preserves selection and
scroll position. New runs and status updates must not shift selection to another
run. An empty project and unreadable history need distinct, explicit messages.

Keep project scope visible. The selected run's Config view provides its complete
identity and checkout context. Search, filtering and cross-project navigation
can be separate work.

## Run view

Keep a compact header visible across all tabs and the artifact pager: task title,
workflow, current run state, current step and elapsed time. It always describes
the run now, even while an earlier review is selected. Put secondary identifiers
and paths in Config. A blocked run shows what requires attention and where to
act; a lost host shows that the outcome is unknown.

Below the header, use plain text tabs with reverse video for the selected tab:
`1 steps`, `2 activity`, `3 config`. The selected tab fills the available width.
Keep a short, context-sensitive key legend at the bottom.

### Steps

Render ordered stage visits as aligned rows: disclosure marker, step name,
participant or check, state, duration and available output count. Repeated
reviews and checks remain separate visits. The selection cursor is independent
of lifecycle status: inspecting review 1 does not make it the active step.

Expand a step directly below its row using indentation and tree characters.
The expansion shows the relevant attempt, dispatch/result information, waiting
reason, gate decision and route, and accepted outputs. Artifact entries are
selectable children. Ordinary explanatory lines do not become extra keyboard
stops. Keep one step expanded at a time in the initial design.

For a rejected review, show the verdict, the gate's route to repair, the accepted
review artifact and its handoff to the same builder when continuity applies.
For active repair, show what the builder received and what the run is waiting
for. Keep work retries, envelope format repair and workflow code repair distinct.

Accepted artifacts, verification evidence and available turn/session references
belong under their step. Turn history is optional and must come from a supported
source. Do not fabricate a transcript or make it a prerequisite for useful step
inspection. Multiple attempts and outputs must retain their visit/attempt identity.
The prototype demonstrates one output per step; the real tree must handle more.

Conditional future steps may appear subdued with explicit prerequisites, such
as `pending repair`. They are possible routes, not a fixed completion checklist.
Do not infer a percentage complete from the number of rows.

### Activity

Use a dense chronological stream of aligned text: time, small marker,
participant, step and meaningful message. Reuse the language of the run-output
brief, for example:

```text
09:13:18  +  reviewer           Agent started · claude / sonnet
09:13:20  →  reviewer  review   Task dispatched
09:13:41  ↓  reviewer  review   Review received · changes requested
09:13:42  ↻  gate      review   Changes requested → repair
09:13:45  →  builder   repair   Task dispatched · same agent
```

Agent startup is worth showing. Raw event names, receipt hashes, pane identifiers
and control envelopes belong in diagnostic detail, not the main narrative.
Separate receipt/acceptance from the gate's decision. An accepted review can ask
for changes; acceptance alone must not look like approval.

Show the current wait and its duration without flooding history with repeated
waiting lines. Follow new activity until the user scrolls into history. Then
preserve reading position, indicate that following is paused and provide an
explicit way to return to the latest entry. New events must not steal focus.

### Config

Use a read-only text document with three sections:

- **Agents:** names, roles when different, provider/CLI kind, configured model and
  stage assignments. Include all configured roles, including a planner when used.
  Distinguish recorded assignment from current runtime observation. An unspecified
  model reads `provider default` or unknown rather than a guessed model name.
- **Input:** pretty-printed input JSON, with explicit abbreviation for large values
  and access to the complete saved input. Preserve structure and readable text.
- **Context:** project and checkout, branch/revision when available, run identity,
  workflow, verification commands, limits and resolved configuration provenance.

Keep configuration stable for the selected run. This view does not edit prompts,
change agent models or alter an in-flight run. Raw envelopes can be optional
read-only diagnostics; they do not need a permanent tab.

### Artifact pager

Opening an artifact replaces the current content with its text while preserving
the run header. Show filename, step, visit/attempt, acceptance or evidence context,
and a copyable path. Use plain text or restrained Markdown styling. Earlier
rejected reviews must remain distinguishable from final approval.

Esc returns to the exact originating entry and reading position. Missing,
unreadable, oversized and non-text files need clear states and a usable reference.
The production reader must support scrolling and long lines without executing
terminal control sequences embedded in file content. It is a reader, not an editor.

## Keyboard navigation

All essential inspection works without a mouse. The prototype implements the
following bindings for its sample content:

| Context           | Key              | Behavior                                                                                                    |
| ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Runs              | Up / Down, k / j | Move selection; stop at the first/last row.                                                                 |
| Runs              | Right / Enter    | Open the selected run, focused on its first step.                                                           |
| Steps             | Up / Down, k / j | Move through visible step rows and artifact children.                                                       |
| Steps             | Right            | Expand a collapsed step; on an expanded step, enter its artifact child if present; on an artifact, open it. |
| Steps             | Left             | Return from an artifact child to its parent; collapse an expanded step. A collapsed root stays selected.    |
| Steps             | Enter            | Toggle the selected step or open the selected artifact.                                                     |
| Steps             | o                | Read the selected step's artifact when available.                                                           |
| Runs / Steps      | Home / End       | Select the first/last visible entry.                                                                        |
| Tab labels        | Left / Right     | Switch tabs, cycling between Steps, Activity and Config.                                                    |
| Steps tab label   | Down / Enter     | Focus the retained step/artifact selection.                                                                 |
| Run view          | 1 / 2 / 3        | Switch to Steps / Activity / Config.                                                                        |
| Activity / Config | Left / Right     | Switch tabs.                                                                                                |
| Artifact pager    | Esc              | Return to the originating entry.                                                                            |
| Run view          | Esc              | Return to the runs list.                                                                                    |
| Browser reference | Tab / Shift+Tab  | Move native keyboard focus between controls.                                                                |

Left/Right in the step tree operate on the tree; on the tab labels they switch
tabs. Use numbered shortcuts to switch tabs directly from a step. In the
production terminal, Tab/Shift+Tab move between tab navigation and content,
while Up/Down, Page Up/Page Down and Home/End scroll read-only documents. The
browser reference uses browser scrolling and does not emulate a terminal pager.

Selection and keyboard focus must remain visible. Switching tabs retains step
selection and expansion; opening another run clears references belonging to the
previous run. Resizing and incoming events must preserve the item being inspected.
The production footer should expose help and an explicit quit binding. Leaving
the interface ends observation only; it never cancels a run.

## Visual language and terminal sizes

Use a monospace character grid, compact spacing, simple horizontal separators,
reverse video and restrained ANSI-style colors. Inline expansions are indented
text. Avoid cards, badges, shadows, rounded containers and persistent inspectors.
The layout should be credible in a terminal with color disabled.

Use cyan for active work, green for successful outcomes, amber for repair or
attention, red for failure or lost observation, and subdued text for context.
Always accompany color with words or symbols. Lost observation still means
unknown outcome, not proven failure.

At about 80 columns, preserve the step, participant and state; move secondary
metadata into the expansion before making the row unreadable. Wider terminals
show more aligned fields rather than introducing side panels. Keep the header,
tabs and key legend visible at limited height and scroll the current content.
Long titles, paths and model names must have a way to reveal their full value.
The browser mockup reflows for narrow screens; terminal resizing needs separate
verification in the implementation.

## Data and scope boundaries

Use engine-owned snapshots and lifecycle observations shared with other Woof
interfaces. Do not reconstruct workflow state from terminal output, agent prose,
idleness or time since the last event. If required information is unavailable,
show that honestly; improvements belong in the shared observation contracts.

Keep accepted submissions, gate decisions and recorded run completion separate.
Keep blocked, failed, exhausted, cancelled and lost-host states distinct. An
observer timeout does not establish a run outcome or imply restart support.
Reconnection must produce a consistent view without duplicated activity or lost
selection. The TUI must remain usable without plugin UI or MCP.

This design covers observation and inspection. Workflow creation, prompt editing,
retry/resume/re-host, terminal emulation and permission approval inside Woof are
outside scope. Use supported Herdr integration for agent/session navigation only
when available; unsupported actions must not appear as working controls.

## Acceptance

- Browse runs, open one, expand a review, select its artifact and return to the
  same tree entry and runs-list position using the keyboard alone.
- Right enters the tree; Left backs out or collapses it. Up/Down traverse visible
  selectable entries without skipping artifacts or selecting hidden children.
- Steps, Activity and Config occupy the main content area. Details expand inline;
  reading an artifact opens a pager and Esc restores its origin.
- Earlier reviews, repeated verification, attempts and repair continuity remain
  unambiguous. Historical selection never overwrites current run status.
- Activity explains startup, dispatch, waiting and gate routing in human language.
  New observations do not interrupt reading or move focus.
- Configuration includes agent models, readable input and resolved run context.
  Unknown values and unavailable evidence remain explicit.
- Empty history, unavailable files, long content, no color, narrow/short terminals
  and observation loss remain usable and truthful.
- Verify real keyboard operation, scrolling, resize, live updates and reconnect in
  a terminal. A sample-data browser prototype does not establish live acceptance.

## Implementation notes

Non-obvious decisions made while building `woof tui`:

- A terminal has no focusable tab labels, so the run view keeps an explicit
  focus of its own, tab bar or content, moved with Tab and Shift+Tab. Left/Right
  switch tabs on the tab bar and in Activity and Config; in the Steps content
  they operate on the tree, and in the pager they pan long lines.
- Activity follows the latest entry until the user scrolls into history; End (or
  scrolling back down to the bottom) resumes following rather than needing a
  separate command.
- `q` and Ctrl+C quit from anywhere; `?` opens a key legend. Quitting only ends
  observation, never the run.
- The artifact pager pans long lines horizontally with Left/Right in addition to
  vertical scrolling, and prints control characters in caret notation instead of
  executing them, so arbitrary file bytes are always safe to display.
- Dispatched requests appear as their own readable `request` children beside
  accepted artifacts and verification evidence under a step; OUTPUT counts only
  accepted artifacts and evidence, not requests.
- Possible next steps come from the recorded workflow graph only when the run's
  workflow is a built-in one at the recorded version; a project's own workflow
  module is never reloaded to read a run, so a project workflow shows no routes.
- The runs list scope is the git top level of `--project` (default the working
  directory); a project outside a git repository lists every run.
- `--frames` is a non-interactive text mode that reads one command per stdin
  line and prints each frame as plain text, for tests and terminals without raw
  input.
- A terminal narrower than 40 columns or shorter than 10 rows shows an explicit
  message instead of a truncated or garbled layout.

Related: [run output](run-output.md),
[observability](../architecture/observability.md),
[domain model](../architecture/domain-model.md), and
[Web UI capabilities](../architecture/web-ui.md).
