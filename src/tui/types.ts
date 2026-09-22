import type { MarkName } from "../observe/render-rows.js";

/**
 * Shared shapes of the terminal UI (`woof tui`). The TUI is an observer: every
 * value here is derived from engine-owned facts (snapshots, run status, the
 * event stream, the run's saved input and recorded configuration) and never
 * from terminal output or elapsed time. Times are ISO timestamps; the view
 * formats durations against the clock it is given.
 */

/** Restrained palette of docs/design/tui.md; undefined is the default foreground. */
export type Tone = "cyan" | "green" | "amber" | "red" | "dim";

/** A run of text with one presentation. Text never holds control characters. */
export interface Span {
  text: string;
  tone?: Tone;
  bold?: boolean;
  /** Selection and the selected tab; kept without color (NO_COLOR). */
  reverse?: boolean;
}

/** One frame line. */
export type Line = Span[];

/** A decoded key press. */
export interface Key {
  name:
    | "up"
    | "down"
    | "left"
    | "right"
    | "home"
    | "end"
    | "pageup"
    | "pagedown"
    | "enter"
    | "escape"
    | "tab"
    | "backtab"
    | "backspace"
    | "char";
  /** For `char`: the character (a single code point). */
  char?: string;
  ctrl?: boolean;
}

/** Row marks: the run-output vocabulary plus active work (`●`) and an unknown outcome (`?`). */
export type TuiMark = MarkName | "active" | "unknown";

/** A state as words, with its mark and tone. The words stay readable without color. */
export interface StateWord {
  word: string;
  mark: TuiMark;
  tone?: Tone;
}

/** One row of the runs list. */
export interface RunRow {
  runId: string;
  runDir: string;
  /** Task title from the saved input, else a truthful `<workflow> · <runId>` label. */
  title: string;
  titleIsFallback: boolean;
  workflow: string | null;
  state: StateWord;
  /** Current or last step label (e.g. `review 2`), null when no step opened. */
  step: string | null;
  openedAt: string;
  /** Terminal time; null while the run has not terminated. */
  endedAt: string | null;
  /** Needs attention: blocked, lost host, ambiguous delivery, observation lost. */
  attention: boolean;
}

/** An explanatory line under an expanded step: `label   value`. */
export interface DetailLine {
  label: string;
  value: string;
  tone?: Tone;
}

/** A readable file belonging to a step: accepted artifact, check evidence or dispatched request. */
export interface ArtifactRef {
  /** Stable id within the run, e.g. `accepted:review:1:1`. */
  id: string;
  kind: "accepted" | "evidence" | "request";
  /** File name shown in the tree. */
  label: string;
  /** Absolute path. */
  path: string;
  /** Path relative to the run directory. */
  relPath: string;
  stageId: string;
  visit: number;
  attempt: number | null;
  /** Acceptance or evidence context, e.g. `accepted review · verdict fail · gate: changes requested → repair`. */
  context: string;
  bytes: number | null;
  sha256: string | null;
}

/** One ordered step row: a stage visit, a check run, or a possible future step. */
export interface StepNode {
  /** Stable across refreshes, e.g. `stage:review:2`, `check:verify:1`, `pending:verify`. */
  id: string;
  kind: "stage" | "check" | "pending";
  /** Display name: `build`, `review 2`, `verify 2`. */
  name: string;
  /** Agent id, `check`, or `—`. */
  participant: string;
  state: StateWord;
  /** When the step's work started (first dispatch / check start); null when unknown or pending. */
  startedAt: string | null;
  /** When it ended (acceptance, gate, check end, termination); null while running or unknown. */
  endedAt: string | null;
  /** Expansion lines; never keyboard stops. */
  details: DetailLine[];
  /** Selectable children, in order. */
  artifacts: ArtifactRef[];
}

/** The compact header: always the run now, never the selected historical step. */
export interface RunHeader {
  title: string;
  workflow: string | null;
  state: StateWord;
  step: string | null;
  openedAt: string;
  endedAt: string | null;
  /** What needs attention and where to act (blocked), or `host lost · outcome unknown`. */
  attention: StateWord | null;
}

export interface AgentConfigRow {
  agentId: string;
  role: string | null;
  kind: string | null;
  /** Configured model; null reads `provider default`. */
  model: string | null;
  /** Stage ids assigned to this agent in the plan. */
  stages: string[];
  /** Recorded runtime assignment/lifecycle, e.g. `assigned pane w1:p2 · working`; null when none recorded. */
  observed: string | null;
}

export interface ConfigDoc {
  agents: AgentConfigRow[];
  /** Parsed saved input; undefined when absent or unreadable (see `inputProblem`). */
  input: unknown;
  /** Absolute path of the saved input, when recorded. */
  inputPath: string | null;
  inputProblem: string | null;
  context: DetailLine[];
}

export interface RunModel {
  runId: string;
  runDir: string;
  header: RunHeader;
  steps: StepNode[];
  /** The line under the steps: `next: …`, `result: completed · approved`, `action: …`, `host lost · outcome unknown`. */
  stepsNote: StateWord | null;
  /** The current wait for the Activity footer: text plus the timestamp it started. */
  wait: { text: string; since: string } | null;
  /** The Activity footer when not waiting: `recorded outcome: completed`, `run blocked; …`. */
  activityNote: StateWord | null;
  config: ConfigDoc;
}
