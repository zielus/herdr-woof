import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { DefinitionResolver } from "../inspect/run-view.js";
import { rendererFor } from "../inspect/run-view.js";
import { listRuns } from "../inspect/runs.js";
import { readRunStatus, type ReadRunStatusResult } from "../inspect/status.js";
import { graphOf } from "../inspect/workflow-graph.js";
import { MAX_EVENTS_LIMIT, readEvents, type RunEvent } from "../observe/events.js";
import type { RunRenderer } from "../observe/render.js";
import { subscribeEvents } from "../observe/subscribe.js";
import type { WorkflowGraph } from "../observe/workflow-graph.js";
import { readArtifact, type ArtifactText } from "./artifact.js";
import { parseKeyName } from "./keys.js";
import { deriveRunModel, runRowOf } from "./model.js";
import { initialState, reconcile, reduce, type KeyContext, type UiState } from "./state.js";
import type { Terminal } from "./terminal.js";
import { lineText, spansFromSgr } from "./text.js";
import type { Key, Line, RunModel, RunRow } from "./types.js";
import { renderFrame, type Frame, type OpenRunData, type RunsData } from "./view.js";

/**
 * `woof tui` wiring: reads the engine's facts, folds keys through the state
 * machine and draws frames. The runs list is re-read with `listRuns`; an open
 * run is read with `readRunStatus` and `readEvents` and then followed with
 * `subscribeEvents`. Events are kept once per seq, so a reconnect resumes from
 * the last cursor without repeating a row, and the Activity rows are rendered
 * again from that list by a fresh run-output renderer whenever the width
 * changes or the journal must be re-read. Nothing here writes to a run.
 */

export interface TuiOptions {
  runsDir: string;
  /** Locator index to list as well; null lists the runs directory only. */
  indexDir: string | null;
  /** Project root the list is scoped to; null lists every project. */
  project: string | null;
  projectLabel: string;
  definitionFor?: DefinitionResolver;
  /** Journal poll interval of a followed run. */
  pollMs: number;
  /** Re-read interval of the runs list and the open run's status (host liveness). */
  refreshMs: number;
  ascii: boolean;
  color: boolean;
  timeZone?: string;
}

interface OpenRun {
  runId: string;
  runDir: string;
  read: Extract<ReadRunStatusResult, { ok: true }> | null;
  problem: string | null;
  input: unknown;
  config: unknown;
  graph: WorkflowGraph | null;
  events: RunEvent[];
  cursor: string | undefined;
  renderer: RunRenderer | null;
  rendererWidth: number;
  activity: Line[];
  model: RunModel | null;
  observation: OpenRunData["observation"];
  unseen: number;
  abort: AbortController;
}

/** The observer session behind both the interactive terminal and `--frames`. */
export class TuiSession {
  state: UiState = initialState();
  columns: number;
  rows: number;
  private runs: RunsData;
  private open: OpenRun | null = null;
  private artifact: { id: string; text: ArtifactText } | null = null;
  private frame: Frame | null = null;
  private readonly changed: () => void;

  constructor(
    private readonly options: TuiOptions,
    size: { columns: number; rows: number },
    changed: () => void = () => {},
  ) {
    this.columns = size.columns;
    this.rows = size.rows;
    this.changed = changed;
    this.runs = { rows: [], problem: null, runsDir: options.runsDir, exists: true, skipped: 0 };
    this.refreshRuns();
  }

  // --- runs ----------------------------------------------------------------------------------------

  refreshRuns(): void {
    try {
      const listed = listRuns({
        runsDir: this.options.runsDir,
        indexDir: this.options.indexDir,
        project: this.options.project,
      });
      const rows: RunRow[] = listed.runs.map((entry) => {
        const read = readRunStatus(entry.runDir);
        if (!read.ok) return runRowOf(entry, null, undefined);
        const input =
          read.snapshot.input === null
            ? undefined
            : readJson(join(entry.runDir, read.snapshot.input.path));
        return runRowOf(entry, read, input);
      });
      this.runs = {
        rows,
        problem: null,
        runsDir: this.options.runsDir,
        exists: listed.exists,
        skipped: listed.skipped.length,
      };
    } catch (error) {
      this.runs = { ...this.runs, rows: [], problem: (error as Error).message };
    }
    this.settle();
  }

  // --- open run ------------------------------------------------------------------------------------

  private openRun(runId: string, runDir: string): void {
    this.closeRun();
    const open: OpenRun = {
      runId,
      runDir,
      read: null,
      problem: null,
      input: undefined,
      config: undefined,
      graph: null,
      events: [],
      cursor: undefined,
      renderer: null,
      rendererWidth: 0,
      activity: [],
      model: null,
      observation: { state: "live", message: null },
      unseen: 0,
      abort: new AbortController(),
    };
    this.open = open;
    this.loadRun(open);
    void this.follow(open);
  }

  private closeRun(): void {
    this.open?.abort.abort();
    this.open = null;
    this.artifact = null;
  }

  /** Reads the run from the start: status, saved files, every event, and the rows they render to. */
  private loadRun(open: OpenRun): void {
    open.events = [];
    open.cursor = undefined;
    open.renderer = null;
    for (;;) {
      const page = readEvents(open.runDir, {
        ...(open.cursor === undefined ? {} : { after: open.cursor }),
        limit: MAX_EVENTS_LIMIT,
      });
      if (!page.ok) {
        open.problem = `${page.reason}: ${page.message}`;
        break;
      }
      this.addEvents(open, page.events, false);
      if (page.events.length < MAX_EVENTS_LIMIT) break;
    }
    this.readRun(open);
    this.rebuildActivity(open);
  }

  /** Re-reads the status (and host liveness) and derives the model again. */
  private readRun(open: OpenRun): void {
    const read = readRunStatus(open.runDir);
    if (!read.ok) {
      open.problem = `${read.reason}: ${read.message}`;
      return;
    }
    if (open.read === null) {
      const snapshot = read.snapshot;
      open.input =
        snapshot.input === null ? undefined : readJson(join(open.runDir, snapshot.input.path));
      open.config =
        snapshot.config === null ? undefined : readJson(join(open.runDir, snapshot.config.path));
      open.graph = this.graphFor(read, open.config, open.input);
    }
    open.read = read;
    open.problem = null;
    open.model = deriveRunModel({
      snapshot: read.snapshot,
      status: read.status,
      runDir: open.runDir,
      events: open.events,
      input: open.input,
      config: open.config,
      graph: open.graph,
      ...(this.options.timeZone === undefined ? {} : { timeZone: this.options.timeZone }),
    });
    if (read.snapshot.outcome !== null && open.observation.state === "live")
      open.observation = { state: "ended", message: null };
  }

  private graphFor(
    read: Extract<ReadRunStatusResult, { ok: true }>,
    config: unknown,
    input: unknown,
  ): WorkflowGraph | null {
    const snapshot = read.snapshot;
    if (snapshot.workflow === null || this.options.definitionFor === undefined) return null;
    const recorded =
      typeof config === "object" && config !== null
        ? (config as Record<string, unknown>)["workflow"]
        : undefined;
    const source =
      typeof recorded === "object" &&
      recorded !== null &&
      typeof (recorded as Record<string, unknown>)["source"] === "string"
        ? ((recorded as Record<string, unknown>)["source"] as string)
        : null;
    try {
      const definition = this.options.definitionFor(snapshot.workflow, source);
      if (definition === undefined) return null;
      return graphOf(definition, { stages: snapshot.stages, checks: snapshot.checks }, input);
    } catch {
      return null;
    }
  }

  /** Appends the events that continue the list (at-least-once delivery: repeats are dropped). */
  private addEvents(open: OpenRun, events: readonly RunEvent[], render: boolean): number {
    let added = 0;
    for (const event of events) {
      if (event.seq !== open.events.length + 1) continue;
      open.events.push(event);
      open.cursor = event.cursor;
      added += 1;
      if (render && open.renderer !== null) {
        const rows = open.renderer.row(event).map(spansFromSgr);
        open.activity.push(...rows);
        if (this.state.run?.activityTop !== null && this.state.run?.activityTop !== undefined)
          open.unseen += rows.length;
      }
    }
    return added;
  }

  /** A fresh renderer at the current width, fed every event from the start. */
  private rebuildActivity(open: OpenRun): void {
    open.activity = [];
    open.renderer = null;
    const read = open.read;
    if (read === null) return;
    const width = this.columns;
    try {
      open.renderer = rendererFor(
        open.runDir,
        read,
        { color: true, ascii: this.options.ascii, input: "summary", width },
        this.options.definitionFor,
      );
    } catch {
      return;
    }
    open.rendererWidth = width;
    for (const event of open.events)
      open.activity.push(...open.renderer.row(event).map(spansFromSgr));
  }

  /**
   * Follows the journal after the last cursor. A subscription that ends
   * (journal corrupt for now, cursor not resumable, directory gone) is
   * reported and retried from the same cursor; a journal replaced by another
   * run is read again from the start.
   */
  private async follow(open: OpenRun): Promise<void> {
    const signal = open.abort.signal;
    while (!signal.aborted) {
      let ended: { reason: string; message: string } | null = null;
      try {
        // oxlint-disable-next-line no-await-in-loop
        for await (const item of subscribeEvents(open.runDir, {
          ...(open.cursor === undefined ? {} : { after: open.cursor }),
          pollMs: this.options.pollMs,
          lockFree: true,
          signal,
        })) {
          if (signal.aborted) return;
          if (item.type === "resync_required" || item.type === "error") {
            ended = { reason: item.reason, message: item.message };
            break;
          }
          const event = item as RunEvent;
          if (open.observation.state === "reconnecting")
            open.observation = { state: "live", message: null };
          if (this.addEvents(open, [event], true) > 0) this.scheduleRead(open);
        }
      } catch (error) {
        ended = { reason: "observation_failed", message: (error as Error).message };
      }
      if (signal.aborted) return;
      if (ended === null) return;
      open.observation = { state: "reconnecting", message: ended.reason };
      if (ended.reason === "cursor_foreign") {
        // Another run now owns the path: nothing folded so far belongs to it.
        open.read = null;
        this.loadRun(open);
      }
      this.changed();
      try {
        // oxlint-disable-next-line no-await-in-loop
        await delay(Math.max(this.options.refreshMs, 250), undefined, { signal });
      } catch {
        return;
      }
      this.readRun(open);
      if (open.observation.state === "reconnecting" && open.read !== null && open.problem === null)
        open.observation = {
          state: open.read.snapshot.outcome === null ? "live" : "ended",
          message: null,
        };
      this.settle();
    }
  }

  private readScheduled = false;

  /** One status re-read per burst of events. */
  private scheduleRead(open: OpenRun): void {
    if (this.readScheduled) return;
    this.readScheduled = true;
    setImmediate(() => {
      this.readScheduled = false;
      if (this.open !== open) return;
      this.readRun(open);
      this.settle();
    });
  }

  /** The periodic re-read: the runs list on the runs screen, the status of an open run. */
  tick(): void {
    if (this.state.screen === "runs") this.refreshRuns();
    else if (this.open !== null) {
      this.readRun(this.open);
      this.settle();
    }
  }

  /** Waits until the open run's pending status re-read ran (for scripted frames). */
  async idle(): Promise<void> {
    await new Promise((done) => setImmediate(done));
  }

  // --- keys and frames -----------------------------------------------------------------------------

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    if (this.open !== null && this.open.rendererWidth !== columns) this.rebuildActivity(this.open);
    this.settle();
  }

  key(key: Key): void {
    const before = this.state;
    this.render();
    const after = reduce(before, key, this.context());
    this.state = after;
    const runBefore = before.screen === "run" ? before.run : null;
    const runAfter = after.screen === "run" ? after.run : null;
    if (runAfter === null && runBefore !== null) {
      this.closeRun();
      this.refreshRuns();
    } else if (runAfter !== null && runAfter.runId !== runBefore?.runId) {
      this.openRun(runAfter.runId, runAfter.runDir);
    }
    if (runAfter !== null && this.open !== null) {
      if (runAfter.activityTop === null) this.open.unseen = 0;
      const pager = runAfter.pager;
      if (pager === null) this.artifact = null;
      else if (this.artifact?.id !== pager.artifact.id)
        this.artifact = { id: pager.artifact.id, text: readArtifact(pager.artifact.path) };
    }
    this.settle();
  }

  /** Keeps selections on their entries after data changed, then asks for a redraw. */
  private settle(): void {
    this.state = reconcile(this.state, this.context());
    this.changed();
  }

  private context(): KeyContext {
    const frame = this.frame;
    return {
      runs: this.runs.rows,
      steps: this.open?.model?.steps ?? [],
      bodyHeight: frame?.bodyHeight ?? Math.max(1, this.rows - 7),
      bodyWidth: frame?.bodyWidth ?? this.columns,
      activityLines: this.open?.activity.length ?? 0,
      activityHeight: frame?.activityHeight ?? Math.max(1, this.rows - 8),
      configLines: frame?.configLines ?? 0,
      pagerLines: frame?.pagerLines ?? 0,
      pagerHeight: frame?.pagerHeight ?? Math.max(1, this.rows - 11),
      pagerWidth: frame?.pagerWidth ?? 0,
    };
  }

  render(now: number = Date.now()): Frame {
    const open = this.open;
    const frame = renderFrame(this.state, {
      project: this.options.projectLabel,
      runs: this.runs,
      run:
        open === null
          ? null
          : {
              model: open.model,
              problem: open.problem,
              activity: open.activity,
              observation: open.observation,
              unseen: open.unseen,
            },
      artifact: this.artifact?.text ?? null,
      columns: this.columns,
      rows: this.rows,
      now,
      ascii: this.options.ascii,
    });
    this.frame = frame;
    // Scroll offsets the frame chose to keep the selection visible become the reading position.
    if (frame.runsTop !== this.state.runs.top)
      this.state = { ...this.state, runs: { ...this.state.runs, top: frame.runsTop } };
    const run = this.state.run;
    if (run !== null && frame.stepsTop !== run.stepsTop)
      this.state = { ...this.state, run: { ...run, stepsTop: frame.stepsTop } };
    return frame;
  }

  close(): void {
    this.closeRun();
  }
}

/** Runs the interactive UI until the user quits. Quitting ends observation only. */
export async function runTui(options: TuiOptions, terminal: Terminal): Promise<number> {
  let scheduled = false;
  let session: TuiSession | undefined;
  let finished = false;
  const draw = () => {
    if (session === undefined || finished) return;
    terminal.draw(session.render().lines, { color: options.color });
  };
  const changed = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      draw();
    });
  };
  session = new TuiSession(options, terminal.size(), changed);
  const active = session;
  return new Promise<number>((done) => {
    const timer = setInterval(() => {
      active.tick();
      // Elapsed times move with the clock even when no fact changed.
      changed();
    }, options.refreshMs);
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      active.close();
      terminal.close();
      done(code);
    };
    const onSignal = () => finish(0);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    terminal.onResize((size) => active.resize(size.columns, size.rows));
    terminal.onKey((key) => {
      active.key(key);
      if (active.state.quit) finish(0);
    });
    draw();
  });
}

/**
 * `--frames`: the same session driven by a script, one command per line — a
 * key name (`down`, `enter`, `esc`, `shift-tab`, `q`, …), `wait <ms>` (let the
 * followed journal advance), `resize <cols>x<rows>` or `frame` — printing the
 * plain text of the frame after the initial read and after every command.
 */
export async function runFrames(
  options: TuiOptions,
  script: string[],
  size: { columns: number; rows: number },
  write: (text: string) => void,
): Promise<number> {
  const session = new TuiSession(options, size);
  const print = (label: string) => {
    const frame = session.render();
    write(`--- ${label} ---\n${frame.lines.map((line) => lineText(line).trimEnd()).join("\n")}\n`);
  };
  try {
    print("start");
    for (const raw of script) {
      const command = raw.trim();
      if (command === "" || command.startsWith("#")) continue;
      const wait = /^wait (\d+)$/.exec(command);
      const resize = /^resize (\d+)x(\d+)$/.exec(command);
      if (wait !== null) {
        // oxlint-disable-next-line no-await-in-loop
        await delay(Number(wait[1]));
        session.tick();
      } else if (resize !== null) {
        session.resize(Number(resize[1]), Number(resize[2]));
      } else if (command !== "frame") {
        const key = parseKeyName(command);
        if (key === undefined) {
          write(`--- unknown command ${JSON.stringify(command)} ---\n`);
          return 1;
        }
        session.key(key);
      }
      // oxlint-disable-next-line no-await-in-loop
      await session.idle();
      print(command);
      if (session.state.quit) break;
    }
    return 0;
  } finally {
    session.close();
  }
}

/** A JSON file's parsed content; undefined when it is missing, unreadable or not JSON. */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
