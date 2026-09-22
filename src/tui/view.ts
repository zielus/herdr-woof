import { duration } from "../observe/render-text.js";
import { marksFor } from "../observe/render-text.js";
import type { ArtifactText } from "./artifact.js";
import type { RunViewState, UiState } from "./state.js";
import { TABS, visibleEntries } from "./state.js";
import { clipToWidth, displayWidth, fitLine, lineWidth, padToWidth, sliceColumns } from "./text.js";
import type {
  DetailLine,
  Line,
  RunModel,
  RunRow,
  Span,
  StateWord,
  StepNode,
  Tone,
  TuiMark,
} from "./types.js";

/**
 * The frame of `woof tui` (pure): the UI state and the observed data become
 * exactly `rows` lines of styled spans. Layout follows docs/design/tui.md: a
 * two-line header that always describes the run now, a rule, the tab line, a
 * rule, the scrolled content, a rule and a context-sensitive key legend. It
 * also reports the document sizes the key reducer scrolls against and the
 * scroll offsets it chose to keep the selection visible.
 */

export interface RunsData {
  rows: RunRow[];
  /** Why the runs directory could not be read; null when it was. */
  problem: string | null;
  runsDir: string;
  exists: boolean;
  /** Entries that hold no readable run. */
  skipped: number;
}

export interface OpenRunData {
  /** Null while the first read is pending or when it failed (`problem`). */
  model: RunModel | null;
  problem: string | null;
  /** Activity rows, already rendered by the run-output renderer. */
  activity: Line[];
  /** Observation of the run's journal. */
  observation: { state: "live" | "reconnecting" | "ended"; message: string | null };
  /** Rows that arrived while following was paused. */
  unseen: number;
}

export interface ViewData {
  /** Project scope label, e.g. `herdr-woof` or `all projects`. */
  project: string;
  runs: RunsData;
  run: OpenRunData | null;
  /** The pager's file, read when the pager opened. */
  artifact: ArtifactText | null;
  columns: number;
  rows: number;
  /** Clock for elapsed times (ms since the epoch). */
  now: number;
  ascii: boolean;
}

export interface Frame {
  lines: Line[];
  bodyHeight: number;
  bodyWidth: number;
  activityLines: number;
  activityHeight: number;
  configLines: number;
  pagerLines: number;
  pagerHeight: number;
  pagerWidth: number;
  /** Scroll offsets the frame used; the caller stores them back. */
  runsTop: number;
  stepsTop: number;
}

export const MIN_COLUMNS = 40;
export const MIN_ROWS = 10;
/** Header (2), rule, tabs, rule, rule, footer. */
const CHROME = 7;

interface Glyphs {
  cursor: string;
  collapsed: string;
  expanded: string;
  branch: string;
  last: string;
  pipe: string;
  rule: string;
  dash: string;
}

const UNICODE: Glyphs = {
  cursor: "›",
  collapsed: "▸",
  expanded: "▾",
  branch: "├",
  last: "└",
  pipe: "│",
  rule: "─",
  dash: "—",
};
const ASCII: Glyphs = {
  cursor: ">",
  collapsed: "+",
  expanded: "-",
  branch: "|",
  last: "`",
  pipe: "|",
  rule: "-",
  dash: "-",
};

function markOf(mark: TuiMark, ascii: boolean): string {
  if (mark === "active") return ascii ? "*" : "●";
  if (mark === "unknown") return "?";
  const glyph = marksFor(ascii)[mark];
  // The ASCII dispatch arrow is two columns; a step row has room for one.
  return glyph.length > 1 ? (glyph[1] as string) : glyph;
}

const span = (text: string, tone?: Tone, extra: Partial<Span> = {}): Span => ({
  text,
  ...(tone === undefined ? {} : { tone }),
  ...extra,
});

export function renderFrame(state: UiState, data: ViewData): Frame {
  const width = data.columns;
  const height = data.rows;
  const glyphs = data.ascii ? ASCII : UNICODE;
  const bodyHeight = Math.max(0, height - CHROME);
  const frame: Frame = {
    lines: [],
    bodyHeight,
    bodyWidth: width,
    activityLines: 0,
    activityHeight: Math.max(1, bodyHeight - 1),
    configLines: 0,
    pagerLines: 0,
    pagerHeight: Math.max(1, bodyHeight - 4),
    pagerWidth: 0,
    runsTop: state.runs.top,
    stepsTop: state.run?.stepsTop ?? 0,
  };
  if (width < MIN_COLUMNS || height < MIN_ROWS) {
    frame.lines = [
      [span(clipToWidth(`woof tui needs at least ${MIN_COLUMNS}x${MIN_ROWS}`, width), "amber")],
      [span(clipToWidth(`this terminal is ${width}x${height}; q quits`, width), "dim")],
    ];
    return pad(frame, width, height, data.ascii);
  }
  const rule: Line = [span(glyphs.rule.repeat(width), "dim")];
  const run = state.screen === "run" ? state.run : null;
  let header: Line[];
  let tabs: Line;
  let body: Line[];
  let footer: string;
  if (run === null) {
    header = runsHeader(data, width);
    tabs = [span(" runs ", undefined, { reverse: true })];
    const view = runsBody(state, data, bodyHeight, width, glyphs);
    body = view.lines;
    frame.runsTop = view.top;
    footer = "↑↓ move  → / enter open  ? help  q quit";
  } else {
    const open = data.run;
    header = runHeader(open, data, width);
    if (run.pager !== null) {
      tabs = [span(" artifact pager ", "cyan", { reverse: true })];
      const view = pagerBody(run, data.artifact, bodyHeight, width, glyphs);
      body = view.lines;
      frame.pagerLines = view.total;
      frame.pagerWidth = view.widest;
      frame.pagerHeight = view.height;
      footer = "esc back to step  ↑↓ pgup/pgdn scroll  ←→ pan  read-only";
    } else {
      tabs = tabLine(run);
      const content = runBody(run, open, data, bodyHeight, width, glyphs, frame);
      body = content;
      footer =
        run.focus === "tabbar"
          ? "←→ switch tab  ↓ / enter content  tab content  1/2/3 tab  esc runs  q quit"
          : run.tab === "steps"
            ? "↑↓ move  → expand / enter  ← parent / collapse  o read  1/2/3 tab  tab tabs  esc runs  q quit"
            : run.tab === "activity"
              ? "↑↓ scroll  end latest  ←→ switch tab  1/2/3 tab  esc runs  q quit"
              : "↑↓ scroll  ←→ switch tab  1/2/3 tab  esc runs  q quit";
    }
  }
  if (state.help) body = helpBody(bodyHeight);
  const lines: Line[] = [...header, rule, tabs, rule];
  for (let index = 0; index < bodyHeight; index += 1) lines.push(body[index] ?? []);
  lines.push(rule, [span(plainArrows(footer, data.ascii), "dim")]);
  frame.lines = lines;
  return pad(frame, width, height, data.ascii);
}

function pad(frame: Frame, width: number, height: number, ascii: boolean): Frame {
  const lines = frame.lines.slice(0, height);
  while (lines.length < height) lines.push([]);
  return { ...frame, lines: lines.map((line) => fitLine(line, width, ascii)) };
}

function plainArrows(value: string, ascii: boolean): string {
  if (!ascii) return value;
  return value
    .replaceAll("↑↓", "up/down")
    .replaceAll("←→", "left/right")
    .replaceAll("→", "right")
    .replaceAll("←", "left")
    .replaceAll("↓", "down");
}

/** `left` then `right`, right-aligned when both fit; `right` is dropped otherwise. */
function spread(left: Line, right: Line, width: number): Line {
  const used = lineWidth(left);
  const room = width - used - lineWidth(right);
  if (room < 2) return left;
  return [...left, span(" ".repeat(room)), ...right];
}

// --- header --------------------------------------------------------------------------------------

function runsHeader(data: ViewData, width: number): Line[] {
  return [
    spread(
      [span("woof", "green", { bold: true }), span(`  runs / ${data.project}`)],
      [span(`${data.runs.rows.length} listed`, "dim")],
      width,
    ),
    [span(`runs dir ${data.runs.runsDir}`, "dim")],
  ];
}

function elapsed(from: string, to: string | null, now: number): string {
  const start = Date.parse(from);
  const end = to === null ? now : Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "unknown";
  const ms = end - start;
  return ms < 1000 && ms >= 0 ? "<1s" : duration(ms);
}

function runHeader(open: OpenRunData | null, data: ViewData, width: number): Line[] {
  const model = open?.model ?? null;
  const observation =
    open === null
      ? []
      : open.observation.state === "live"
        ? [span("live", "cyan")]
        : open.observation.state === "reconnecting"
          ? [span("reconnecting", "amber")]
          : [span("history", "dim")];
  if (model === null) {
    return [
      spread([span("woof", "green", { bold: true }), span("  run")], observation, width),
      [span(open?.problem ?? "reading run…", open?.problem == null ? "dim" : "red")],
    ];
  }
  const head = model.header;
  const state = head.state;
  const second: Line = [
    ...(head.workflow === null ? [] : [span(head.workflow, "dim"), span("  ")]),
    span(`${state.word}${head.step === null ? "" : ` · ${head.step}`}`, state.tone),
    span("  "),
    span(elapsed(head.openedAt, head.endedAt, data.now), "dim"),
  ];
  if (head.attention !== null) {
    second.push(span("  "), span(head.attention.word, head.attention.tone));
  }
  return [
    spread([span("woof", "green", { bold: true }), span(`  ${head.title}`)], observation, width),
    second,
  ];
}

function tabLine(run: RunViewState): Line {
  const line: Line = [];
  TABS.forEach((tab, index) => {
    if (index > 0) line.push(span("   "));
    const selected = run.tab === tab;
    const label = ` ${index + 1} ${tab} `;
    line.push(
      selected
        ? span(label, undefined, {
            reverse: true,
            ...(run.focus === "tabbar" ? { bold: true } : {}),
          })
        : span(label, "dim"),
    );
  });
  if (run.focus === "tabbar") line.push(span("   ← tabs focused", "dim"));
  return line;
}

// --- runs ----------------------------------------------------------------------------------------

function runsBody(
  state: UiState,
  data: ViewData,
  height: number,
  width: number,
  glyphs: Glyphs,
): { lines: Line[]; top: number } {
  const runs = data.runs;
  if (runs.problem !== null) {
    return {
      lines: [
        [span(`Cannot read the runs directory: ${runs.problem}`, "red")],
        [span(`runs dir ${runs.runsDir}`, "dim")],
      ],
      top: 0,
    };
  }
  if (runs.rows.length === 0) {
    const lines: Line[] = [
      [
        span(
          runs.exists
            ? `No runs for ${data.project} in ${runs.runsDir}.`
            : `No runs yet: ${runs.runsDir} does not exist.`,
          "dim",
        ),
      ],
    ];
    if (runs.skipped > 0)
      lines.push([span(`${runs.skipped} entries hold no readable run and were skipped.`, "amber")]);
    lines.push([span("New runs appear here as they start.", "dim")]);
    return { lines, top: 0 };
  }
  const showWorkflow = width >= 100;
  const stateWidth = 12;
  const stepWidth = 10;
  const timeWidth = 8;
  const workflowWidth = showWorkflow ? 18 : 0;
  const titleWidth = Math.max(
    10,
    width -
      2 -
      stateWidth -
      1 -
      1 -
      (showWorkflow ? workflowWidth + 1 : 0) -
      stepWidth -
      1 -
      timeWidth,
  );
  const columns = (cells: Array<[string, number, Tone | undefined, boolean?]>): Line =>
    cells.flatMap(([text, cellWidth, tone, right], index) => {
      const clipped = clipToWidth(text, cellWidth);
      const fill = " ".repeat(Math.max(0, cellWidth - displayWidth(clipped)));
      const cell = right === true ? fill + clipped : clipped + fill;
      return index === 0 ? [span(cell, tone)] : [span(" "), span(cell, tone)];
    });
  const headRow = columns([
    [" ", 1, "dim"],
    ["STATE", stateWidth, "dim"],
    ["RUN", titleWidth, "dim"],
    ...(showWorkflow ? [["WORKFLOW", workflowWidth, "dim"] as [string, number, Tone]] : []),
    ["STEP", stepWidth, "dim"],
    ["TIME", timeWidth, "dim", true],
  ]);
  const listHeight = Math.max(1, height - 3);
  const index = Math.max(
    0,
    runs.rows.findIndex((row) => row.runId === state.runs.selected),
  );
  const top = keepVisible(state.runs.top, index, listHeight, runs.rows.length);
  const lines: Line[] = [headRow];
  for (const [at, row] of runs.rows.entries()) {
    if (at < top || at >= top + listHeight) continue;
    const selected = row.runId === state.runs.selected;
    const title = clipToWidth(row.title, titleWidth);
    lines.push([
      span(selected ? glyphs.cursor : " ", "cyan"),
      span(" "),
      span(padToWidth(clipToWidth(row.state.word, stateWidth), stateWidth), row.state.tone),
      span(" "),
      span(title, row.titleIsFallback ? "dim" : undefined, selected ? { reverse: true } : {}),
      span(" ".repeat(Math.max(0, titleWidth - displayWidth(title)))),
      ...(showWorkflow
        ? [
            span(" "),
            span(
              padToWidth(clipToWidth(row.workflow ?? "unknown", workflowWidth), workflowWidth),
              "dim",
            ),
          ]
        : []),
      span(" "),
      span(padToWidth(clipToWidth(row.step ?? glyphs.dash, stepWidth), stepWidth), "dim"),
      span(" "),
      span(
        padStart(clipToWidth(elapsed(row.openedAt, row.endedAt, data.now), timeWidth), timeWidth),
        "dim",
      ),
    ]);
  }
  while (lines.length < listHeight + 1) lines.push([]);
  const counts = summaryCounts(runs.rows);
  lines.push([], [span([data.project, ...counts].join(" · "), "dim")]);
  if (runs.skipped > 0) lines.push([span(`${runs.skipped} unreadable entries skipped`, "amber")]);
  return { lines, top };
}

function summaryCounts(rows: RunRow[]): string[] {
  const attention = rows.filter((row) => row.attention).length;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.attention) continue;
    counts.set(row.state.word, (counts.get(row.state.word) ?? 0) + 1);
  }
  return [
    ...[...counts].map(([word, count]) => `${count} ${word}`),
    ...(attention > 0 ? [`${attention} need${attention === 1 ? "s" : ""} attention`] : []),
  ];
}

function padStart(value: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(value))) + value;
}

/** A first visible index that keeps `index` inside a window of `height` over `count` entries. */
function keepVisible(top: number, index: number, height: number, count: number): number {
  let next = Math.min(top, Math.max(0, count - height));
  if (index < next) next = index;
  if (index >= next + height) next = index - height + 1;
  return Math.max(0, next);
}

// --- run view ------------------------------------------------------------------------------------

function runBody(
  run: RunViewState,
  open: OpenRunData | null,
  data: ViewData,
  height: number,
  width: number,
  glyphs: Glyphs,
  frame: Frame,
): Line[] {
  const model = open?.model ?? null;
  if (open === null || model === null) {
    return [
      [
        span(
          open?.problem == null ? "Reading the run…" : `Cannot read the run: ${open.problem}`,
          open?.problem == null ? "dim" : "red",
        ),
      ],
      [span(`run dir ${run.runDir}`, "dim")],
    ];
  }
  if (run.tab === "steps") {
    const view = stepsBody(run, model, data, height, width, glyphs);
    frame.stepsTop = view.top;
    return view.lines;
  }
  if (run.tab === "activity") {
    const view = activityBody(run, open, model, data, height, width);
    frame.activityLines = view.total;
    return view.lines;
  }
  const doc = configDoc(model, width, data.ascii);
  frame.configLines = doc.length;
  const top = Math.max(0, Math.min(run.configTop, doc.length - height));
  return doc.slice(top, top + height);
}

function stepsBody(
  run: RunViewState,
  model: RunModel,
  data: ViewData,
  height: number,
  width: number,
  glyphs: Glyphs,
): { lines: Line[]; top: number } {
  if (model.steps.length === 0) {
    const lines: Line[] = [[span("No step has opened yet.", "dim")]];
    if (model.stepsNote !== null) lines.push([], noteLine(model.stepsNote, data.ascii));
    return { lines, top: 0 };
  }
  const nameWidth = clampWidth(
    model.steps.map((step) => step.name),
    6,
    14,
  );
  const ownerWidth = clampWidth(
    model.steps.map((step) => step.participant),
    5,
    12,
  );
  const timeWidth = 6;
  const showOutput = width >= 72;
  const outputWidth = showOutput ? 10 : 0;
  const fixed =
    6 + nameWidth + 1 + ownerWidth + 1 + 1 + timeWidth + (showOutput ? 1 + outputWidth : 0);
  const stateWidth = Math.max(8, width - fixed);
  const doc: Line[] = [];
  doc.push([
    span(
      `      ${padToWidth("STEP", nameWidth)} ${padToWidth("OWNER", ownerWidth)} ${padToWidth("STATE", stateWidth)} ${padStart("TIME", timeWidth)}${showOutput ? ` ${"OUTPUT"}` : ""}`,
      "dim",
    ),
  ]);
  const entries = visibleEntries(model.steps, run.expanded);
  const cursor = run.cursor ?? entries[0] ?? null;
  const contentFocus = run.focus === "content";
  let cursorLine = 1;
  for (const step of model.steps) {
    const onStep = cursor !== null && cursor.step === step.id && cursor.artifact === null;
    if (onStep) cursorLine = doc.length;
    const expanded = run.expanded === step.id;
    const pending = step.kind === "pending";
    const name = padToWidth(clipToWidth(step.name, nameWidth, data.ascii), nameWidth);
    const time = stepTime(step, data.now, glyphs);
    doc.push([
      span(onStep ? glyphs.cursor : " ", "cyan", onStep && contentFocus ? { reverse: true } : {}),
      span(" "),
      span(expanded ? glyphs.expanded : glyphs.collapsed, "dim"),
      span(" "),
      span(markOf(step.state.mark, data.ascii), step.state.tone),
      span(" "),
      span(
        name,
        pending ? "dim" : expanded ? "cyan" : undefined,
        onStep && contentFocus ? { reverse: true } : {},
      ),
      span(" "),
      span(padToWidth(clipToWidth(step.participant, ownerWidth, data.ascii), ownerWidth), "dim"),
      span(" "),
      span(
        padToWidth(clipToWidth(step.state.word, stateWidth - 1, data.ascii), stateWidth - 1),
        step.state.tone,
      ),
      span(" "),
      span(padStart(time, timeWidth), "dim"),
      ...(showOutput
        ? [span(" "), span(clipToWidth(outputLabel(step, glyphs), outputWidth, data.ascii), "dim")]
        : []),
    ]);
    if (!expanded) continue;
    const indent = "     ";
    const labelWidth = Math.max(10, ...step.details.map((detail) => displayWidth(detail.label)));
    for (const detail of step.details) {
      for (const line of detailLines(detail, labelWidth, width - indent.length - 2, glyphs.pipe))
        doc.push([span(indent), ...line]);
    }
    if (step.artifacts.length === 0) {
      doc.push([
        span(indent),
        span(`${glyphs.last} ${pending ? "no output yet" : "no accepted output"}`, "dim"),
      ]);
    }
    step.artifacts.forEach((artifact, index) => {
      const onArtifact = cursor !== null && cursor.artifact === artifact.id;
      if (onArtifact) cursorLine = doc.length;
      const branch = index === step.artifacts.length - 1 ? glyphs.last : glyphs.branch;
      const label = artifact.kind === "accepted" ? "artifact" : artifact.kind;
      doc.push([
        span(indent),
        span(`${branch} ${padToWidth(label, labelWidth)} `, "dim"),
        span(onArtifact ? glyphs.cursor : " ", "cyan"),
        span(artifact.label, "cyan", onArtifact && contentFocus ? { reverse: true } : {}),
        span(onArtifact ? "  [enter to read]" : "", "dim"),
      ]);
    });
  }
  if (model.stepsNote !== null) doc.push([], noteLine(model.stepsNote, data.ascii));
  const top = keepVisible(run.stepsTop, cursorLine, height, doc.length);
  return { lines: doc.slice(top, top + height), top };
}

function clampWidth(values: string[], min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.max(0, ...values.map((value) => displayWidth(value)))));
}

function stepTime(step: StepNode, now: number, glyphs: Glyphs): string {
  if (step.startedAt === null) return glyphs.dash;
  if (step.endedAt === null && step.kind === "pending") return glyphs.dash;
  return elapsed(step.startedAt, step.endedAt, now);
}

/** Accepted artifacts and evidence; dispatched requests are inputs, not outputs. */
function outputLabel(step: StepNode, glyphs: Glyphs): string {
  const count = step.artifacts.filter((artifact) => artifact.kind !== "request").length;
  if (count === 0) return glyphs.dash;
  return count === 1 ? "1 output" : `${count} outputs`;
}

function detailLines(detail: DetailLine, labelWidth: number, width: number, pipe: string): Line[] {
  const room = Math.max(10, width - labelWidth - 3);
  return wrapText(detail.value, room).map((piece, index) => [
    span(`${pipe} ${padToWidth(index === 0 ? detail.label : "", labelWidth)} `, "dim"),
    span(piece, detail.tone ?? "dim"),
  ]);
}

function noteLine(note: StateWord, ascii: boolean): Line {
  return [span(`${markOf(note.mark, ascii)} ${note.word}`, note.tone)];
}

/** Word wrap by display width; a word longer than the width is split. */
export function wrapText(value: string, width: number): string[] {
  const limit = Math.max(4, width);
  const lines: string[] = [];
  let current = "";
  for (const word of value.split(" ")) {
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (displayWidth(candidate) <= limit) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    current = word;
    while (displayWidth(current) > limit) {
      const head = sliceColumns(current, 0, limit);
      lines.push(head);
      current = current.slice(head.length);
    }
  }
  lines.push(current);
  return lines;
}

function activityBody(
  run: RunViewState,
  open: OpenRunData,
  model: RunModel,
  data: ViewData,
  height: number,
  width: number,
): { lines: Line[]; total: number } {
  const rows = open.activity;
  const view = Math.max(1, height - 1);
  const max = Math.max(0, rows.length - view);
  const following = run.activityTop === null;
  const top = following ? max : Math.min(run.activityTop ?? max, max);
  const lines: Line[] =
    rows.length === 0 ? [[span("No activity recorded yet.", "dim")]] : rows.slice(top, top + view);
  while (lines.length < view) lines.push([]);
  let status: Line;
  if (!following) {
    status = [
      span(
        `paused · lines ${top + 1}-${Math.min(rows.length, top + view)} of ${rows.length}${open.unseen > 0 ? ` · ${open.unseen} new` : ""} · end returns to latest`,
        "amber",
      ),
    ];
  } else if (open.observation.state === "reconnecting") {
    status = [
      span(
        `observation interrupted · reconnecting${open.observation.message === null ? "" : ` (${open.observation.message})`}`,
        "amber",
      ),
    ];
  } else if (model.wait !== null) {
    const since = model.wait.since === "" ? "" : ` · ${elapsed(model.wait.since, null, data.now)}`;
    status = [span(`${markOf("dot", data.ascii)} ${model.wait.text}${since}`, "dim")];
  } else if (model.activityNote !== null) {
    status = noteLine(model.activityNote, data.ascii);
  } else {
    status = [span(following ? "following" : "", "dim")];
  }
  lines.push(fitLine(status, width, data.ascii));
  return { lines, total: rows.length };
}

// --- config --------------------------------------------------------------------------------------

/** Lines of the JSON input preview before it is cut. */
const INPUT_PREVIEW_LINES = 40;
/** Characters of one string value before it is abbreviated. */
const STRING_PREVIEW = 160;

function configDoc(model: RunModel, width: number, ascii: boolean): Line[] {
  const config = model.config;
  const doc: Line[] = [[span("agents", "dim")]];
  const idWidth = clampWidth(
    config.agents.map((agent) => agent.agentId),
    8,
    14,
  );
  const kindWidth = clampWidth(
    config.agents.map((agent) => agent.kind ?? "unknown"),
    6,
    10,
  );
  const modelWidth = clampWidth(
    config.agents.map((agent) => agent.model ?? "provider default"),
    8,
    24,
  );
  if (config.agents.length === 0) doc.push([span("no agents recorded", "dim")]);
  for (const agent of config.agents) {
    const stages = agent.stages.length === 0 ? "no stage" : agent.stages.join(", ");
    doc.push([
      span(padToWidth(clipToWidth(agent.agentId, idWidth, ascii), idWidth)),
      span("  "),
      span(padToWidth(clipToWidth(agent.kind ?? "unknown", kindWidth, ascii), kindWidth)),
      span("  "),
      span(
        padToWidth(clipToWidth(agent.model ?? "provider default", modelWidth, ascii), modelWidth),
        agent.model === null ? "dim" : undefined,
      ),
      span("  "),
      span(stages, "dim"),
    ]);
    const extra: string[] = [];
    if (agent.role !== null && agent.role !== agent.agentId) extra.push(`role ${agent.role}`);
    if (displayWidth(agent.model ?? "") > modelWidth) extra.push(`model ${agent.model}`);
    extra.push(
      agent.observed === null ? "no runtime assignment recorded" : `recorded: ${agent.observed}`,
    );
    for (const piece of wrapText(extra.join(" · "), width - 4))
      doc.push([span(`    ${piece}`, "dim")]);
  }
  doc.push([], [span("input · saved input", "dim")]);
  if (config.inputProblem !== null) {
    doc.push([span(config.inputProblem, "amber")]);
  } else {
    const json = previewJson(config.input);
    const shown = json.slice(0, INPUT_PREVIEW_LINES);
    for (const line of shown) {
      for (const piece of wrapIndentedText(line, width)) doc.push([span(piece)]);
    }
    if (json.length > shown.length)
      doc.push([span(`… ${json.length - shown.length} more lines not shown`, "amber")]);
  }
  if (config.inputPath !== null) {
    for (const piece of wrapText(`full input: ${config.inputPath}`, width))
      doc.push([span(piece, "dim")]);
  }
  doc.push([], [span("context", "dim")]);
  const labelWidth = Math.max(10, ...config.context.map((line) => displayWidth(line.label)));
  for (const line of config.context) {
    wrapText(line.value, Math.max(10, width - labelWidth - 2)).forEach((piece, index) => {
      doc.push([
        span(padToWidth(index === 0 ? line.label : "", labelWidth), "dim"),
        span("  "),
        span(piece, line.tone),
      ]);
    });
  }
  return doc;
}

/** A long JSON line wraps at spaces, its continuation indented under its text. */
function wrapIndentedText(line: string, width: number): string[] {
  if (displayWidth(line) <= width) return [line];
  const indent = /^ */.exec(line)?.[0] ?? "";
  const lead = `${indent}  `;
  return wrapText(line.slice(indent.length), Math.max(8, width - lead.length)).map(
    (piece, index) => `${index === 0 ? indent : lead}${piece}`,
  );
}

/** Splits text into pieces of at most `width` columns without dropping a character. */
function wrapChars(value: string, width: number): string[] {
  const pieces: string[] = [];
  let rest = value;
  while (displayWidth(rest) > width) {
    const head = sliceColumns(rest, 0, width);
    const taken = head.length === 0 ? rest.slice(0, 1) : head;
    pieces.push(taken);
    rest = rest.slice(taken.length);
  }
  pieces.push(rest);
  return pieces;
}

/** Pretty JSON with long strings abbreviated, saying how much was left out. */
export function previewJson(value: unknown): string[] {
  const abbreviated = JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (typeof item !== "string" || item.length <= STRING_PREVIEW) return item;
      return `${item.slice(0, STRING_PREVIEW)}… (${item.length - STRING_PREVIEW} more characters)`;
    },
    2,
  );
  return (abbreviated ?? "null").split("\n").map(controlFree);
}

function controlFree(value: string): string {
  // oxlint-disable-next-line no-control-regex
  return value.replaceAll(/[\u0000-\u001F\u007F-\u009F]/g, " ");
}

// --- pager ---------------------------------------------------------------------------------------

function pagerBody(
  run: RunViewState,
  artifact: ArtifactText | null,
  height: number,
  width: number,
  glyphs: Glyphs,
): { lines: Line[]; total: number; widest: number; height: number } {
  const pager = run.pager as NonNullable<RunViewState["pager"]>;
  const ref = pager.artifact;
  // The path is shown whole (wrapped), so it can be copied.
  const head: Line[] = [
    [span(`${ref.label} · ${pager.stepName} · ${ref.context}`, "dim")],
    ...wrapChars(ref.path, width).map((piece) => [span(piece)]),
    [span(glyphs.rule.repeat(width), "dim")],
  ];
  const view = Math.max(1, height - head.length - 1);
  if (artifact === null || !artifact.ok) {
    const lines: Line[] = [...head];
    if (artifact === null) lines.push([span("reading…", "dim")]);
    else {
      lines.push([span(`${artifact.state.replace("_", " ")}: ${artifact.message}`, "red")]);
    }
    lines.push(
      [],
      [
        span(
          `recorded ${ref.bytes === null ? "size unknown" : `${ref.bytes} bytes`}${ref.sha256 === null ? "" : ` · sha256 ${ref.sha256}`}`,
          "dim",
        ),
      ],
      [span(`reference ${ref.relPath} (relative to the run directory)`, "dim")],
    );
    return { lines, total: 0, widest: 0, height: view };
  }
  const content = artifact.lines;
  const widest = Math.max(0, ...content.map((line) => displayWidth(line)));
  const max = Math.max(0, content.length - view);
  const top = Math.min(pager.top, max);
  const lines: Line[] = [...head];
  for (const line of content.slice(top, top + view))
    lines.push([span(sliceColumns(line, pager.left, width))]);
  while (lines.length < head.length + view) lines.push([]);
  const end = Math.min(content.length, top + view);
  const position =
    content.length === 0
      ? "(empty file)"
      : end >= content.length
        ? `(END) lines ${top + 1}-${end} of ${content.length}`
        : `lines ${top + 1}-${end} of ${content.length}`;
  const notes = [
    position,
    ...(pager.left > 0 ? [`columns from ${pager.left + 1}`] : []),
    ...(widest > width && pager.left === 0 ? ["long lines: ←→ pan"] : []),
    ...(artifact.truncated ? [`showing the first part of ${artifact.bytes} bytes`] : []),
  ];
  lines.push([span(notes.join(" · "), artifact.truncated ? "amber" : "dim")]);
  return { lines, total: content.length, widest, height: view };
}

// --- help ----------------------------------------------------------------------------------------

function helpBody(height: number): Line[] {
  const rows: Array<[string, string]> = [
    ["runs", "↑↓ / k j move · → / enter open · home / end first / last"],
    ["steps", "↑↓ / k j move · → expand, enter child, open · ← parent, collapse"],
    ["", "enter toggle or open · o read the step's artifact · home / end"],
    ["tabs", "1 / 2 / 3 switch · tab / shift+tab move between tabs and content"],
    ["", "←→ on the tabs, in activity and config switch tabs"],
    ["documents", "↑↓ pgup pgdn home end scroll · end resumes following activity"],
    ["pager", "↑↓ pgup pgdn space home end scroll · ←→ pan · esc back to the entry"],
    ["leave", "esc back · q or ctrl+c quit · quitting never stops the run"],
  ];
  const lines: Line[] = [[span("keys · ? or esc closes help", "dim")], []];
  for (const [label, text] of rows) lines.push([span(padToWidth(label, 11), "dim"), span(text)]);
  return lines.slice(0, height);
}
