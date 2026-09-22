import { relative } from "node:path";

import type { RunStatusView } from "../inspect/status.js";
import type { RunResult } from "../state/result.js";
import type { RunSnapshot } from "../state/snapshot.js";
import { timeOf, type FormattableEvent } from "./format.js";
import { openingLines, rule } from "./render-opening.js";
import { emptyRowState, rowsOf, type Row, type RowContext, type RowState } from "./render-rows.js";
import {
  clampWidth,
  clip,
  duration,
  marksFor,
  pad,
  paintFor,
  participantLabel,
  plainText,
  plural,
  sanitize,
  stageLabel,
  text,
  words,
  wrap,
  wrapIndented,
  wrapPath,
  type Layout,
  type RenderOptions,
  type Style,
} from "./render-text.js";
import type { WorkflowGraph } from "./workflow-graph.js";

/**
 * The human-readable run view (pure: no I/O, no process access). It turns
 * engine facts — a snapshot, the status view, the run's persisted input and
 * the event stream — into the presentation of docs/design/run-output.md: an
 * opening block (context, roster, stage map, input preview), one history row
 * per meaningful fact, and an outcome summary. `woof watch` prints it; a run
 * host can print the same lines, since both consume the same facts.
 *
 * The renderer is stateful only to tell rows apart: which agent already worked
 * on another stage, whether an attempt is a retry, where a phase begins. That
 * state is folded from the events in order, so attaching to a run and replaying
 * its history prints exactly the rows a live observer printed.
 */

export interface RunRendererInput {
  snapshot: RunSnapshot;
  status: RunStatusView;
  /** Parsed content of the run's `input.json`; undefined when absent or unreadable. */
  input: unknown;
  /** The repository the run works in and its branch, when the caller knows them. */
  repository?: { path: string; branch: string | null } | null;
  /** Stage graph of the run's workflow; null draws the plan's stage list instead. */
  graph?: WorkflowGraph | null;
  options: Partial<RenderOptions>;
}

/** What the summary is built from: the final status, the derived result and the final snapshot. */
export interface RunEnd {
  status: RunStatusView;
  result: RunResult | null;
  snapshot: RunSnapshot;
}

export interface RunRenderer {
  /** The opening block: context lines, AGENTS, STEPS & GATES, INPUT, then a rule. */
  opening(): string[];
  /** The history rows of one event (possibly none, possibly with a leading blank line). */
  row(event: FormattableEvent): string[];
  /** The outcome summary of a terminated run: a rule, outcome, duration and counts, ARTIFACTS. */
  summary(end: RunEnd): string[];
  /** The unresolved block of a run the observer leaves, with the supported next action. */
  blocked(status: RunStatusView): string[];
  /** The line printed when observation ends while the run goes on. */
  observerStopped(reason: string): string;
}

export function createRunRenderer(input: RunRendererInput): RunRenderer {
  const { snapshot, status } = input;
  const options: RenderOptions = {
    color: input.options.color ?? false,
    ascii: input.options.ascii ?? false,
    input: input.options.input ?? "summary",
    width: clampWidth(input.options.width),
    ...(input.options.timeZone === undefined ? {} : { timeZone: input.options.timeZone }),
    ...(input.options.home === undefined ? {} : { home: input.options.home }),
    ...(input.options.jsonPreviewLines === undefined
      ? {}
      : { jsonPreviewLines: input.options.jsonPreviewLines }),
  };
  const layout = layoutOf(snapshot, options);
  const ctx: RowContext = {
    roster: new Map(
      snapshot.agents.map((agent) => [
        agent.agentId,
        {
          kind: agent.kind,
          model: agent.model,
          tabId: agent.assignment?.tabId ?? null,
          paneId: agent.assignment?.paneId ?? null,
        },
      ]),
    ),
    verdictStages: new Set(
      snapshot.stages
        .filter((stage) => stage.verdicts !== null && stage.verdicts.length > 0)
        .map((stage) => stage.stageId),
    ),
  };
  const state: RowState = emptyRowState();
  let phaseFresh = true;
  const graph = input.graph ?? null;
  const out = (line: string) => plainText(line, options.ascii);

  return {
    opening(): string[] {
      return openingLines(
        { snapshot, status, repository: input.repository ?? null, graph, input: input.input },
        layout,
      ).map(out);
    },

    row(event: FormattableEvent): string[] {
      const lines: string[] = [];
      for (const row of rowsOf(event, state, ctx)) {
        if (row.phase && !phaseFresh) {
          lines.push("");
          phaseFresh = true;
        }
        if (row.message === "") continue;
        lines.push(...rowLines(row, layout));
        if (!row.lifecycle) phaseFresh = false;
      }
      return lines.map(out);
    },

    summary(end: RunEnd): string[] {
      return summaryLines(end, snapshot, layout).map(out);
    },

    blocked(current: RunStatusView): string[] {
      return blockedLines(current, ctx, layout).map(out);
    },

    observerStopped(reason: string): string {
      return out(layout.paint(`-- observer stopped (${text(reason)}); the run continues`, "dim"));
    },
  };
}

/**
 * Column geometry from the plan. Ids are clipped before the columns are sized,
 * so a long agent or stage id widens its column only up to the clip and the
 * message column keeps its room at 80 columns.
 */
function layoutOf(snapshot: RunSnapshot, options: RenderOptions): Layout {
  const marks = marksFor(options.ascii);
  const participantWidth = Math.max(
    4,
    ...snapshot.agents.map((agent) => participantLabel(agent.agentId, options.ascii).length),
  );
  const stageWidth = Math.max(
    0,
    ...snapshot.stages.map((stage) => stageLabel(stage.stageId, options.ascii).length),
    ...(snapshot.checks ?? []).map((check) => stageLabel(check, options.ascii).length),
  );
  // time, space, mark, space, participant, [space, stage,] two spaces.
  const prefixWidth =
    8 + 1 + marks.width + 1 + participantWidth + (stageWidth === 0 ? 0 : 1 + stageWidth) + 2;
  return {
    marks,
    paint: paintFor(options.color),
    options,
    participantWidth,
    stageWidth,
    prefixWidth,
    messageWidth: Math.max(20, options.width - prefixWidth),
  };
}

// --- history rows --------------------------------------------------------------------------------

function rowLines(row: Row, layout: Layout): string[] {
  const { marks, paint, options } = layout;
  const mark = pad(marks[row.mark], marks.width);
  const time = paint(timeOf(row.ts, options.timeZone), "dim");
  // Clipped to the column the plan sized, so an id the plan did not name cannot shift the message.
  const participant = pad(
    clip(text(row.participant), layout.participantWidth, options.ascii),
    layout.participantWidth,
  );
  const stage =
    layout.stageWidth === 0
      ? ""
      : ` ${paint(pad(clip(text(row.stage), layout.stageWidth, options.ascii), layout.stageWidth), "dim")}`;
  const prefix = `${time} ${paint(mark, row.style)} ${participant}${stage}  `;
  const indent = " ".repeat(layout.prefixWidth);
  const lines: string[] = [];
  for (const [index, piece] of wrap(sanitize(row.message), layout.messageWidth).entries()) {
    lines.push(`${index === 0 ? prefix : indent}${paint(piece, row.style)}`);
  }
  for (const detail of row.detail) {
    for (const piece of wrap(sanitize(detail), layout.messageWidth))
      lines.push(`${indent}${piece}`);
  }
  return lines;
}

// --- summary -------------------------------------------------------------------------------------

function summaryLines(end: RunEnd, opening: RunSnapshot, layout: Layout): string[] {
  const { paint, marks, options } = layout;
  const { status, result, snapshot } = end;
  const outcome = snapshot.outcome;
  const lines: string[] = ["", rule(layout)];
  // Every summary line fits the width; a wrapped line continues under its text.
  const emit = (line: string, style: Style | undefined) => {
    for (const piece of wrapIndented(line, options.width, 2)) lines.push(paint(piece, style));
  };
  if (outcome === null) {
    emit(`${marks.dot} Run not finished · ${text(status.status)}`, "dim");
    return lines;
  }
  const reason = text(outcome.reason);
  switch (outcome.outcome) {
    case "completed":
      emit(`${marks.ok} Completed · ${reason}`, "green");
      break;
    case "failed":
      emit(`${marks.alert} Failed · ${reason}`, "red");
      break;
    case "exhausted": {
      const limit = outcome.limit;
      const value = limit === null || snapshot.limits === null ? undefined : snapshot.limits[limit];
      emit(
        `${marks.alert} Exhausted · ${limit === null ? "limit" : text(limit)}${value === undefined ? "" : ` (${limit?.endsWith("Ms") === true ? duration(value) : String(value)})`}`,
        "red",
      );
      emit(reason, undefined);
      break;
    }
    default:
      emit(`${marks.dot} Cancelled · ${reason}`, "dim");
  }
  const openedAt = Date.parse(snapshot.openedAt);
  const endedAt = Date.parse(outcome.at);
  const facts = [
    duration(endedAt - openedAt),
    plural(reviewCount(snapshot, opening), "review"),
    plural(repairCount(snapshot), "repair"),
  ];
  if (outcome.outcome !== "completed" && result?.location != null) {
    const at = result.location;
    facts.push(
      `last at ${text(at.stageId)}${at.visit > 1 ? ` visit ${at.visit}` : ""}${at.attempt > 1 ? ` attempt ${at.attempt}` : ""}`,
    );
  }
  emit(facts.join(" · "), "dim");
  if (result?.blocked != null && outcome.outcome !== "completed") {
    emit(
      `${marks.alert} still blocked at the end: ${words(result.blocked.reason)} · ${text(result.blocked.agentId)}`,
      "red",
    );
  }
  lines.push("");
  lines.push(...artifactLines(result, status.runDir, layout));
  return lines;
}

/**
 * The accepted artifacts of the completing revision. `review` appears only when
 * the result names one: a review that approved an earlier revision is not
 * presented as the run's review, and no line stands in for it.
 */
function artifactLines(result: RunResult | null, runDir: string, layout: Layout): string[] {
  const { paint, options } = layout;
  const items: Array<[string, string]> = [];
  if (result !== null) {
    const { completion, review, verification } = result.artifacts;
    if (completion !== null) items.push(["changes", relative(runDir, completion.acceptedPath)]);
    if (review !== null) items.push(["review", relative(runDir, review.acceptedPath)]);
    if (verification !== null) items.push(["checks", relative(runDir, verification.path)]);
  }
  if (items.length === 0) return [paint("ARTIFACTS · none accepted", "dim")];
  const width = Math.max(...items.map(([label]) => label.length));
  const column = width + 2;
  return [
    paint("ARTIFACTS · relative to run directory", "dim"),
    ...items.flatMap(([label, path]) =>
      wrapPath(sanitize(path), options.width - column).map((piece, index) =>
        index === 0 ? `${pad(label, width)}  ${piece}` : `${" ".repeat(column)}${piece}`,
      ),
    ),
  ];
}

/** Gate decisions on stages whose submissions carry a verdict. */
function reviewCount(snapshot: RunSnapshot, opening: RunSnapshot): number {
  const verdictStages = new Set(
    [...snapshot.stages, ...opening.stages]
      .filter((stage) => stage.verdicts !== null && stage.verdicts.length > 0)
      .map((stage) => stage.stageId),
  );
  let count = 0;
  for (const [gate, decisions] of Object.entries(snapshot.counters.gatesByGate)) {
    if (verdictStages.has(gate)) count += decisions;
  }
  return count;
}

/** Rejections that sent the run to another stage (a repair), not back to the same one. */
function repairCount(snapshot: RunSnapshot): number {
  return snapshot.gates.filter(
    (gate) =>
      gate.decision === "reject" && "stageId" in gate.next && gate.next.stageId !== gate.gate,
  ).length;
}

// --- observer stop -------------------------------------------------------------------------------

function blockedLines(status: RunStatusView, ctx: RowContext, layout: Layout): string[] {
  const { paint, marks } = layout;
  const block = status.attention.blocked;
  if (block === null) return [];
  const entry = ctx.roster.get(block.agentId);
  const where =
    entry?.tabId != null
      ? ` (tab ${text(entry.tabId)})`
      : entry?.paneId != null
        ? ` (pane ${text(entry.paneId)})`
        : "";
  const width = layout.options.width;
  const command = "  supported action: woof run cancel ";
  return [
    ...wrapIndented(
      `${marks.alert} Blocked: ${words(block.reason)} · ${text(block.agentId)}${where}`,
      width,
      2,
    ).map((piece) => paint(piece, "red")),
    ...wrap(sanitize(block.requiredAction), Math.max(20, width - 2)).map((piece) => `  ${piece}`),
    ...wrapPath(text(status.runDir), Math.max(8, width - command.length)).map((piece, index) =>
      paint(index === 0 ? `${command}${piece}` : `${" ".repeat(command.length)}${piece}`, "dim"),
    ),
  ];
}
