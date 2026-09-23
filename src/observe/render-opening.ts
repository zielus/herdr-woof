import type { RunStatusView } from "../inspect/status.js";
import type { RunSnapshot } from "../state/snapshot.js";
import {
  clip,
  duration,
  isObject,
  KIND_CLIP,
  MODEL_CLIP,
  pad,
  participantLabel,
  plural,
  sanitize,
  shortenHome,
  text,
  wrap,
  wrapIndented,
  wrapPath,
  type Layout,
} from "./render-text.js";
import type { WorkflowGraph } from "./workflow-graph.js";

/**
 * The opening block of the human run view (pure): context lines, the AGENTS
 * roster, the STEPS & GATES map with its repair routes and limits, and the
 * INPUT preview, closed by a rule. Everything is derived from the snapshot,
 * the status view, the workflow graph (when known) and the input value.
 */

export interface OpeningInput {
  snapshot: RunSnapshot;
  status: RunStatusView;
  repository: { path: string; branch: string | null } | null;
  graph: WorkflowGraph | null;
  input: unknown;
}

const DEFAULT_JSON_LINES = 24;
const INPUT_FILE = "input.json";

export function openingLines(input: OpeningInput, layout: Layout): string[] {
  const { snapshot, status } = input;
  return [
    ...contextLines(snapshot, status, input.repository, layout),
    "",
    ...rosterLines(snapshot, layout),
    "",
    ...mapLines(snapshot, input.graph, layout),
    "",
    ...inputLines(snapshot, input.input, layout),
    "",
    rule(layout),
  ];
}

function contextLines(
  snapshot: RunSnapshot,
  status: RunStatusView,
  repository: { path: string; branch: string | null } | null,
  layout: Layout,
): string[] {
  const { paint, options } = layout;
  const workflow = snapshot.workflow;
  const repo =
    repository === null
      ? ""
      : `  ${paint(
          [
            basename(repository.path),
            ...(repository.branch === null ? [] : [text(repository.branch)]),
          ].join(" · "),
          "dim",
        )}`;
  // A long run id continues under itself (split, never shortened: it is what
  // `woof status` takes); the run directory breaks at `/` and stays copyable.
  const dir = shortenHome(text(status.runDir), options.home);
  const runLines = wrap(text(snapshot.runId), options.width - 4).map((piece, index) =>
    index === 0 ? `run ${piece}` : `    ${piece}`,
  );
  if (workflow !== null) {
    const suffix = ` · workflow v${text(workflow.version)}`;
    const last = runLines.length - 1;
    if (runLines[last]!.length + suffix.length <= options.width) runLines[last] += suffix;
    else runLines.push(`   ${suffix}`);
  }
  return [
    `${paint("woof", "cyan")} / ${paint(workflow === null ? "plan-less run" : text(workflow.name), "bold")}${repo}`,
    ...runLines.map((piece) => paint(piece, "dim")),
    ...wrapPath(dir, options.width - 4).map((piece, index) =>
      paint(index === 0 ? `dir ${piece}` : `    ${piece}`, "dim"),
    ),
    ...checkoutLines(snapshot, layout),
  ];
}

/**
 * `checkout worktree · woof/<run> · from <source>` and the checkout's path under it, when the run
 * records one; a child run adds the parent run and step it belongs to.
 */
function checkoutLines(snapshot: RunSnapshot, layout: Layout): string[] {
  const { paint, options } = layout;
  const lines: string[] = [];
  const parent = snapshot.parent;
  if (parent !== null) {
    lines.push(
      ...wrap(
        `parent ${text(parent.runId)} · step ${text(parent.stageId)}${parent.visit > 1 ? ` visit ${parent.visit}` : ""}`,
        options.width,
      ).map((piece) => paint(piece, "dim")),
    );
  }
  const checkout = snapshot.checkout;
  if (checkout === null) return lines;
  const head = [
    checkout.inherited ? `${text(checkout.mode)} (inherited)` : text(checkout.mode),
    ...(checkout.branch === null ? [] : [text(checkout.branch)]),
    ...(checkout.mode === "worktree"
      ? [`from ${shortenHome(text(checkout.source), options.home)}`]
      : []),
    ...(checkout.created && !checkout.keep ? ["removed when completed"] : []),
  ];
  lines.push(...wrap(`checkout ${head.join(" · ")}`, options.width).map((p) => paint(p, "dim")));
  if (checkout.mode !== "current" || checkout.inherited) {
    lines.push(
      ...wrapPath(shortenHome(text(checkout.path), options.home), options.width - 4).map((piece) =>
        paint(`    ${piece}`, "dim"),
      ),
    );
  }
  return lines;
}

function rosterLines(snapshot: RunSnapshot, layout: Layout): string[] {
  const { paint } = layout;
  const lines = [paint("AGENTS", "dim")];
  if (snapshot.agents.length === 0) {
    lines.push(paint("no planned agents", "dim"));
    return lines;
  }
  // Fixed fields are clipped like the participant column, so a long id, kind or
  // model cannot push the row past the width; the stage list wraps under itself.
  const ascii = layout.options.ascii;
  const rows = snapshot.agents.map((agent) => ({
    name: participantLabel(agent.agentId, ascii),
    kind: clip(agent.kind === null ? "unknown kind" : text(agent.kind), KIND_CLIP, ascii),
    model: clip(agent.model === null ? "provider default" : text(agent.model), MODEL_CLIP, ascii),
    stages: snapshot.stages
      .filter((stage) => stage.agentId === agent.agentId)
      .map((stage) => text(stage.stageId))
      .join(", "),
    role: agent.role !== null && agent.role !== agent.agentId ? text(agent.role) : null,
  }));
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const kindWidth = Math.max(...rows.map((row) => row.kind.length));
  const modelWidth = Math.max(...rows.map((row) => row.model.length));
  const column = nameWidth + kindWidth + modelWidth + 9;
  const room = layout.options.width - column;
  for (const row of rows) {
    const head = `${paint(pad(row.name, nameWidth), "bold")}   ${pad(row.kind, kindWidth)}   ${pad(row.model, modelWidth)}   `;
    const tail = [
      row.stages === "" ? "no stage" : row.stages,
      ...(row.role === null ? [] : [`role ${row.role}`]),
    ].join("   ");
    const pieces = tail.length <= room ? [tail] : wrap(tail, room);
    for (const [index, piece] of pieces.entries()) {
      lines.push(
        index === 0
          ? `${head}${paint(piece, "dim")}`
          : `${" ".repeat(column)}${paint(piece, "dim")}`,
      );
    }
  }
  return lines;
}

function mapLines(snapshot: RunSnapshot, graph: WorkflowGraph | null, layout: Layout): string[] {
  const { paint, options } = layout;
  const lines = [paint("STEPS & GATES", "dim")];
  let roundNoun = "rounds";
  const dim = (line: string) => wrapIndented(line, options.width, 2).map((p) => paint(p, "dim"));
  if (graph === null) {
    const stages = snapshot.stages.map((stage) =>
      stage.workflow === undefined
        ? text(stage.stageId)
        : `${text(stage.stageId)} (workflow ${text(stage.workflow)})`,
    );
    const checks = snapshot.checks ?? [];
    lines.push(
      ...wrapIndented(
        [
          stages.length === 0 ? "no planned stages" : `stages ${stages.join(", ")}`,
          ...(checks.length === 0 ? [] : [`checks ${checks.map(text).join(", ")}`]),
        ].join(" · "),
        options.width,
        2,
      ),
    );
  } else {
    if (graph.roundStage !== null) roundNoun = `${text(graph.roundStage)} rounds`;
    const main = mainPath(graph);
    lines.push(...wrapIndented(main.map(text).join(" → "), options.width, 2));
    for (const route of rejectRoutes(graph, main)) {
      const body = `reject ↘ ${route.path.map(text).join(" → ")}`;
      const column = columnOf(main, route.from);
      if (column + body.length <= options.width) {
        lines.push(`${" ".repeat(column)}${paint(body, "dim")}`);
      } else {
        lines.push(...dim(`${text(route.from)} ${body}`));
      }
    }
    const gates = graph.nodes.flatMap((node) => {
      if (node.kind === "check")
        return node.command === null ? [] : [`${text(node.id)}: ${sanitize(node.command)}`];
      if (node.kind === "workflow")
        return node.command === null
          ? []
          : [`${text(node.id)}: runs workflow ${text(node.command)}`];
      return node.bindsRevision ? [`${text(node.id)}: verdict + matching revision`] : [];
    });
    if (gates.length > 0) lines.push(...dim(gates.join(" · ")));
  }
  const limits = snapshot.limits;
  if (limits !== null) {
    lines.push(
      ...dim(
        `limits: ${limits.maxRounds} ${roundNoun} · ${limits.maxAttemptsPerVisit} attempts/visit · ${limits.maxVisitsPerStage} visits/stage · ${duration(limits.runTimeoutMs)} run`,
      ),
    );
  }
  return lines;
}

/** From the start, the first edge not yet on the path, until a terminal outcome or a dead end. */
function mainPath(graph: WorkflowGraph): string[] {
  const path = [graph.start];
  let current = graph.start;
  for (let step = 0; step < graph.nodes.length + 2; step += 1) {
    const targets = graph.edges[current] ?? [];
    const next = targets.find((target) => !path.includes(target));
    if (next === undefined) break;
    path.push(next);
    if (isOutcome(next)) break;
    current = next;
  }
  return path;
}

/** Off-path edges of each main-path node, followed back around to the node itself. */
function rejectRoutes(
  graph: WorkflowGraph,
  main: string[],
): Array<{ from: string; path: string[] }> {
  const routes: Array<{ from: string; path: string[] }> = [];
  for (const [index, node] of main.entries()) {
    if (isOutcome(node)) continue;
    const successor = main[index + 1];
    for (const target of graph.edges[node] ?? []) {
      if (target === successor || target === node || isOutcome(target) || main.includes(target)) {
        continue;
      }
      const path = [target];
      let current = target;
      for (let step = 0; step < graph.nodes.length + 2 && current !== node; step += 1) {
        const at = main.indexOf(current);
        const next = at === -1 ? (graph.edges[current] ?? [])[0] : main[at + 1];
        if (next === undefined || path.includes(next)) break;
        path.push(next);
        current = next;
      }
      routes.push({ from: node, path });
    }
  }
  return routes;
}

function columnOf(main: string[], node: string): number {
  const index = main.indexOf(node);
  return main.slice(0, index).reduce((column, item) => column + item.length + " → ".length, 0);
}

function isOutcome(id: string): boolean {
  return id === "completed" || id === "failed";
}

function inputLines(snapshot: RunSnapshot, input: unknown, layout: Layout): string[] {
  const { paint, options } = layout;
  const lines = [paint("INPUT", "dim")];
  if (snapshot.input === null && input === undefined) {
    lines.push(paint("no input recorded", "dim"));
    return lines;
  }
  const recordedBytes = snapshot.input?.bytes;
  if (input === undefined) {
    lines.push(
      paint(
        `input: ${recordedBytes === undefined ? "?" : recordedBytes} bytes · full input: ${INPUT_FILE} (not readable here)`,
        "dim",
      ),
    );
    return lines;
  }
  if (options.input === "json") {
    lines.push(...jsonPreview(input, layout));
    return lines;
  }
  const title = titleOf(input);
  const criteria = criteriaCount(input);
  if (title !== undefined)
    lines.push(paint(clip(sanitize(title), options.width, options.ascii), "bold"));
  const tail: string[] = [];
  if (criteria !== undefined) {
    tail.push(criteria === 1 ? "1 acceptance criterion" : `${criteria} acceptance criteria`);
  }
  if (title === undefined && criteria === undefined) {
    const bytes = recordedBytes ?? Buffer.byteLength(JSON.stringify(input) ?? "", "utf8");
    tail.push(`input: ${bytes} bytes`);
  }
  tail.push(`full input: ${INPUT_FILE}`);
  lines.push(paint(tail.join(" · "), "dim"));
  return lines;
}

/** The first title-like string: `title`, `summary`, `task.title`, `task.summary`, or a string `task`. */
function titleOf(input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  for (const key of ["title", "summary"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  const task = input["task"];
  if (typeof task === "string" && task.trim() !== "") return task.trim();
  if (isObject(task)) {
    for (const key of ["title", "summary"]) {
      const value = task[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  return undefined;
}

function criteriaCount(input: unknown): number | undefined {
  if (!isObject(input)) return undefined;
  for (const holder of [input, isObject(input["task"]) ? input["task"] : undefined]) {
    if (holder === undefined) continue;
    for (const key of ["acceptanceCriteria", "criteria"]) {
      const value = holder[key];
      if (Array.isArray(value)) return value.length;
    }
  }
  return undefined;
}

const KEY_LINE = /^(\s*)("(?:[^"\\]|\\.)*")(:\s?)(.*)$/;
const STRING_VALUE = /^"(?:[^"\\]|\\.)*",?$/;

function jsonPreview(input: unknown, layout: Layout): string[] {
  const { paint, options } = layout;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input, null, 2);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined)
    return [paint(`input is not JSON · full input: ${INPUT_FILE}`, "dim")];
  const all = serialized.split("\n");
  const limit = Math.max(1, options.jsonPreviewLines ?? DEFAULT_JSON_LINES);
  const shown = all.slice(0, limit);
  const lines = shown.map((raw) => {
    const line = sanitize(raw);
    const clipped = clip(line, options.width, options.ascii);
    if (!options.color) return clipped;
    const match = KEY_LINE.exec(clipped);
    if (match !== null) {
      const [, indent, key, colon, rest] = match as unknown as [
        string,
        string,
        string,
        string,
        string,
      ];
      return `${indent}${paint(key, "cyan")}${colon}${STRING_VALUE.test(rest) ? paint(rest, "green") : rest}`;
    }
    const trimmed = clipped.trimStart();
    return STRING_VALUE.test(trimmed)
      ? `${clipped.slice(0, clipped.length - trimmed.length)}${paint(trimmed, "green")}`
      : clipped;
  });
  const remaining = all.length - shown.length;
  lines.push(
    paint(
      remaining > 0
        ? `… (${plural(remaining, "more line")}, full input: ${INPUT_FILE})`
        : `full input: ${INPUT_FILE}`,
      "dim",
    ),
  );
  return lines;
}

/** A full-width horizontal rule. */
export function rule(layout: Layout): string {
  return layout.paint((layout.options.ascii ? "-" : "─").repeat(layout.options.width), "dim");
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return text(index === -1 ? trimmed : trimmed.slice(index + 1));
}
