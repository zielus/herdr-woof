import type { ArtifactRef, Key, StepNode } from "./types.js";

/**
 * The key → state machine of `woof tui` (pure). It follows the key table of
 * docs/design/tui.md: selection is kept by id (a run id, a step id and an
 * artifact id), so refreshes and new events never move it to another entry,
 * and every scroll offset is a reading position the user chose. The terminal
 * has no focusable tab labels, so the run view holds an explicit focus: the tab
 * bar or the content. Nothing here reaches the run: quitting ends observation.
 */

export type Tab = "steps" | "activity" | "config";
export const TABS: readonly Tab[] = ["steps", "activity", "config"];

export interface TreeCursor {
  step: string;
  /** Selected artifact child of `step`; null selects the step row itself. */
  artifact: string | null;
}

export interface PagerState {
  artifact: ArtifactRef;
  /** Step that owns the artifact, for the pager's context line. */
  stepName: string;
  top: number;
  left: number;
}

export interface RunViewState {
  runId: string;
  runDir: string;
  tab: Tab;
  focus: "tabbar" | "content";
  /** The one expanded step. */
  expanded: string | null;
  cursor: TreeCursor | null;
  /** Index of the cursor among visible entries, to fall back on when its entry disappears. */
  cursorIndex: number;
  /** First visible body line of each document. */
  stepsTop: number;
  /** Null follows the latest activity; a number is a reading position (following paused). */
  activityTop: number | null;
  configTop: number;
  pager: PagerState | null;
}

export interface UiState {
  screen: "runs" | "run";
  runs: { selected: string | null; index: number; top: number };
  run: RunViewState | null;
  help: boolean;
  quit: boolean;
}

/** What the reducer needs to know about the content on screen. */
export interface KeyContext {
  /** Runs list, in display order. */
  runs: ReadonlyArray<{ runId: string; runDir: string }>;
  /** Steps of the open run; empty while it loads. */
  steps: readonly StepNode[];
  /** Body height in lines. */
  bodyHeight: number;
  /** Body width in columns (horizontal pager scroll). */
  bodyWidth: number;
  activityLines: number;
  /** Lines the Activity document shows at once (the body less its pinned status line). */
  activityHeight: number;
  configLines: number;
  pagerLines: number;
  /** Lines the pager shows at once (the body less its context and status lines). */
  pagerHeight: number;
  /** Widest pager line in columns. */
  pagerWidth: number;
}

export function initialState(): UiState {
  return {
    screen: "runs",
    runs: { selected: null, index: 0, top: 0 },
    run: null,
    help: false,
    quit: false,
  };
}

/** A visible, selectable entry of the step tree. */
export interface TreeEntry {
  step: string;
  artifact: string | null;
}

/** Step rows and, under the expanded step, its artifact children. */
export function visibleEntries(steps: readonly StepNode[], expanded: string | null): TreeEntry[] {
  return steps.flatMap((step) => [
    { step: step.id, artifact: null },
    ...(step.id === expanded
      ? step.artifacts.map((artifact) => ({ step: step.id, artifact: artifact.id }))
      : []),
  ]);
}

function sameEntry(a: TreeEntry | null, b: TreeEntry): boolean {
  return a !== null && a.step === b.step && a.artifact === b.artifact;
}

export function openRun(state: UiState, run: { runId: string; runDir: string }): UiState {
  return {
    ...state,
    screen: "run",
    help: false,
    run: {
      runId: run.runId,
      runDir: run.runDir,
      tab: "steps",
      focus: "content",
      expanded: null,
      cursor: null,
      cursorIndex: 0,
      stepsTop: 0,
      activityTop: null,
      configTop: 0,
      pager: null,
    },
  };
}

/**
 * Keeps selections on their entries after the content changed: the selected
 * run and step stay selected by id; when one disappeared (a pending step became
 * a real one, a run left the list), the entry now at its former index is chosen.
 * A run view with no cursor yet selects its first step.
 */
export function reconcile(state: UiState, ctx: KeyContext): UiState {
  let runs = state.runs;
  if (ctx.runs.length === 0) {
    runs = { ...runs, selected: null, index: 0 };
  } else {
    const found = ctx.runs.findIndex((run) => run.runId === runs.selected);
    const index = found === -1 ? Math.min(runs.index, ctx.runs.length - 1) : found;
    runs = { ...runs, selected: (ctx.runs[index] as { runId: string }).runId, index };
  }
  let run = state.run;
  if (run !== null && ctx.steps.length > 0) {
    const expanded = ctx.steps.some((step) => step.id === run?.expanded) ? run.expanded : null;
    const entries = visibleEntries(ctx.steps, expanded);
    const found = entries.findIndex((entry) => sameEntry(run?.cursor ?? null, entry));
    const index = found === -1 ? Math.min(run.cursorIndex, entries.length - 1) : found;
    const cursor = entries[index] as TreeEntry;
    run = { ...run, expanded, cursor, cursorIndex: index };
  }
  if (runs === state.runs && run === state.run) return state;
  return { ...state, runs, run };
}

export function reduce(state: UiState, key: Key, ctx: KeyContext): UiState {
  if (key.ctrl === true && key.char === "c") return { ...state, quit: true };
  if (state.help) {
    if (key.name === "escape" || isChar(key, "?")) return { ...state, help: false };
    if (isChar(key, "q")) return { ...state, quit: true };
    return state;
  }
  if (isChar(key, "q")) return { ...state, quit: true };
  if (isChar(key, "?")) return { ...state, help: true };
  if (state.screen === "runs" || state.run === null) return runsKey(state, key, ctx);
  const run = state.run;
  if (run.pager !== null) return withRun(state, pagerKey(run, run.pager, key, ctx));
  if (key.name === "escape") return { ...state, screen: "runs", run: null };
  const digit = key.name === "char" ? TABS[Number(key.char) - 1] : undefined;
  if (digit !== undefined && /^[123]$/.test(key.char ?? "")) {
    return withRun(state, { ...run, tab: digit, focus: "content" });
  }
  if (key.name === "tab" || key.name === "backtab") {
    return withRun(state, { ...run, focus: run.focus === "tabbar" ? "content" : "tabbar" });
  }
  if (run.focus === "tabbar") return withRun(state, tabbarKey(run, key));
  if (run.tab === "steps") return withRun(state, stepsKey(run, key, ctx));
  if (key.name === "left" || key.name === "right") return withRun(state, switchTab(run, key));
  if (run.tab === "activity") return withRun(state, activityKey(run, key, ctx));
  return withRun(state, {
    ...run,
    configTop: scroll(run.configTop, key, ctx.configLines, ctx.bodyHeight),
  });
}

function withRun(state: UiState, run: RunViewState): UiState {
  return run === state.run ? state : { ...state, run };
}

function isChar(key: Key, char: string): boolean {
  return key.name === "char" && key.ctrl !== true && key.char === char;
}

function isUp(key: Key): boolean {
  return key.name === "up" || isChar(key, "k");
}

function isDown(key: Key): boolean {
  return key.name === "down" || isChar(key, "j");
}

function runsKey(state: UiState, key: Key, ctx: KeyContext): UiState {
  const count = ctx.runs.length;
  if (count === 0) return state;
  const index = Math.max(0, Math.min(count - 1, state.runs.index));
  if (key.name === "right" || key.name === "enter") {
    const run = ctx.runs[index] as { runId: string; runDir: string };
    return openRun({ ...state, runs: { ...state.runs, selected: run.runId, index } }, run);
  }
  const next = move(index, key, count, ctx.bodyHeight);
  if (next === undefined) return state;
  const selected = (ctx.runs[next] as { runId: string }).runId;
  return { ...state, runs: { ...state.runs, selected, index: next } };
}

/** The new index for a movement key over `count` entries; undefined for any other key. */
function move(index: number, key: Key, count: number, page: number): number | undefined {
  const last = count - 1;
  if (isUp(key)) return Math.max(0, index - 1);
  if (isDown(key)) return Math.min(last, index + 1);
  if (key.name === "home") return 0;
  if (key.name === "end") return last;
  if (key.name === "pageup") return Math.max(0, index - Math.max(1, page - 1));
  if (key.name === "pagedown") return Math.min(last, index + Math.max(1, page - 1));
  return undefined;
}

function switchTab(run: RunViewState, key: Key): RunViewState {
  const step = key.name === "right" ? 1 : TABS.length - 1;
  const tab = TABS[(TABS.indexOf(run.tab) + step) % TABS.length] as Tab;
  return { ...run, tab };
}

function tabbarKey(run: RunViewState, key: Key): RunViewState {
  if (key.name === "left" || key.name === "right") return switchTab(run, key);
  if (key.name === "down" || key.name === "enter") return { ...run, focus: "content" };
  return run;
}

function stepsKey(run: RunViewState, key: Key, ctx: KeyContext): RunViewState {
  const entries = visibleEntries(ctx.steps, run.expanded);
  if (entries.length === 0) return run;
  const found = entries.findIndex((entry) => sameEntry(run.cursor, entry));
  const index = found === -1 ? Math.min(run.cursorIndex, entries.length - 1) : found;
  const entry = entries[index] as TreeEntry;
  const step = ctx.steps.find((item) => item.id === entry.step) as StepNode;
  const select = (next: TreeEntry, expanded = run.expanded): RunViewState => {
    const list = visibleEntries(ctx.steps, expanded);
    const at = Math.max(
      0,
      list.findIndex((item) => sameEntry(next, item)),
    );
    return { ...run, expanded, cursor: next, cursorIndex: at };
  };
  const moved = move(index, key, entries.length, ctx.bodyHeight);
  if (moved !== undefined) return select(entries[moved] as TreeEntry);
  switch (key.name) {
    case "right":
      if (entry.artifact !== null) return openPager(run, step, entry.artifact);
      if (run.expanded === step.id) {
        const first = step.artifacts[0];
        return first === undefined ? run : select({ step: step.id, artifact: first.id });
      }
      return select({ step: step.id, artifact: null }, step.id);
    case "left":
      if (entry.artifact !== null) return select({ step: step.id, artifact: null });
      if (run.expanded === step.id) return select({ step: step.id, artifact: null }, null);
      return run;
    case "enter":
      if (entry.artifact !== null) return openPager(run, step, entry.artifact);
      return select({ step: step.id, artifact: null }, run.expanded === step.id ? null : step.id);
    default:
      if (isChar(key, "o")) {
        const artifact = entry.artifact ?? step.artifacts[0]?.id;
        return artifact === undefined ? run : openPager(run, step, artifact);
      }
      return run;
  }
}

function openPager(run: RunViewState, step: StepNode, artifactId: string): RunViewState {
  const artifact = step.artifacts.find((item) => item.id === artifactId);
  if (artifact === undefined) return run;
  return { ...run, pager: { artifact, stepName: step.name, top: 0, left: 0 } };
}

function activityKey(run: RunViewState, key: Key, ctx: KeyContext): RunViewState {
  const max = Math.max(0, ctx.activityLines - ctx.activityHeight);
  if (key.name === "end") return { ...run, activityTop: null };
  const current = Math.min(run.activityTop ?? max, max);
  const next = scroll(current, key, ctx.activityLines, ctx.activityHeight);
  if (next === current) return run;
  // Reaching the end again resumes following.
  return { ...run, activityTop: next >= max ? null : next };
}

/** A document's new first line after a scroll key, clamped to the document. */
function scroll(top: number, key: Key, lines: number, height: number): number {
  const max = Math.max(0, lines - height);
  const page = Math.max(1, height - 1);
  let next = top;
  if (isUp(key)) next = top - 1;
  else if (isDown(key)) next = top + 1;
  else if (key.name === "pageup") next = top - page;
  else if (key.name === "pagedown" || isChar(key, " ")) next = top + page;
  else if (key.name === "home") next = 0;
  else if (key.name === "end") next = max;
  return Math.max(0, Math.min(max, next));
}

function pagerKey(run: RunViewState, pager: PagerState, key: Key, ctx: KeyContext): RunViewState {
  if (key.name === "escape") return { ...run, pager: null };
  let { top, left } = pager;
  const maxLeft = Math.max(0, ctx.pagerWidth - ctx.bodyWidth);
  if (key.name === "left") left = Math.max(0, left - 8);
  else if (key.name === "right") left = Math.min(maxLeft, left + 8);
  else top = scroll(top, key, ctx.pagerLines, ctx.pagerHeight);
  if (top === pager.top && left === pager.left) return run;
  return { ...run, pager: { ...pager, top, left } };
}
