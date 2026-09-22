import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

// The pure key → state machine behind `woof tui` (state.ts), checked against the
// key table and acceptance list of docs/design/tui.md. Steps are hand-built:
// build (one artifact), review (two), verify (none) and repair (one).
interface Key {
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
  char?: string;
  ctrl?: boolean;
}
interface ArtifactRef {
  id: string;
  kind: "accepted" | "evidence" | "request";
  label: string;
  path: string;
  relPath: string;
  stageId: string;
  visit: number;
  attempt: number | null;
  context: string;
  bytes: number | null;
  sha256: string | null;
}
interface StepNode {
  id: string;
  kind: "stage" | "check" | "pending";
  name: string;
  participant: string;
  state: { word: string; mark: string };
  startedAt: string | null;
  endedAt: string | null;
  details: Array<{ label: string; value: string }>;
  artifacts: ArtifactRef[];
}
type Tab = "steps" | "activity" | "config";
interface Cursor {
  step: string;
  artifact: string | null;
}
interface RunViewState {
  runId: string;
  runDir: string;
  tab: Tab;
  focus: "tabbar" | "content";
  expanded: string | null;
  cursor: Cursor | null;
  cursorIndex: number;
  stepsTop: number;
  activityTop: number | null;
  configTop: number;
  pager: { artifact: ArtifactRef; stepName: string; top: number; left: number } | null;
}
interface UiState {
  screen: "runs" | "run";
  runs: { selected: string | null; index: number; top: number };
  run: RunViewState | null;
  help: boolean;
  quit: boolean;
}
interface KeyContext {
  runs: ReadonlyArray<{ runId: string; runDir: string }>;
  steps: readonly StepNode[];
  bodyHeight: number;
  bodyWidth: number;
  activityLines: number;
  activityHeight: number;
  configLines: number;
  pagerLines: number;
  pagerHeight: number;
  pagerWidth: number;
}
interface StateModule {
  initialState: () => UiState;
  openRun: (state: UiState, run: { runId: string; runDir: string }) => UiState;
  reconcile: (state: UiState, ctx: KeyContext) => UiState;
  reduce: (state: UiState, key: Key, ctx: KeyContext) => UiState;
}

let initialState: StateModule["initialState"];
let openRun: StateModule["openRun"];
let reconcile: StateModule["reconcile"];
let reduce: StateModule["reduce"];

beforeAll(async () => {
  ({ initialState, openRun, reconcile, reduce } = await loadDist<StateModule>("tui/state.js"));
});

const HOME = "/tmp/woof-home/runs";

function artifact(id: string, label: string): ArtifactRef {
  return {
    id,
    kind: "accepted",
    label,
    path: `${HOME}/run-01/${label}`,
    relPath: label,
    stageId: id.split(":")[1] as string,
    visit: 1,
    attempt: 1,
    context: "",
    bytes: null,
    sha256: null,
  };
}

function step(id: string, name: string, artifacts: ArtifactRef[] = []): StepNode {
  return {
    id,
    kind: id.split(":")[0] as StepNode["kind"],
    name,
    participant: "builder",
    state: { word: "accepted", mark: "ok" },
    startedAt: null,
    endedAt: null,
    details: [],
    artifacts,
  };
}

const BUILD_A = artifact("accepted:build:1:1", "build.md");
const REVIEW_A = artifact("accepted:review:1:1", "review.md");
const REVIEW_B = artifact("evidence:review:1:1", "diff.patch");
const REPAIR_A = artifact("accepted:repair:1:1", "repair.md");

const STEPS: StepNode[] = [
  step("stage:build:1", "build", [BUILD_A]),
  step("stage:review:1", "review", [REVIEW_A, REVIEW_B]),
  step("check:verify:1", "verify"),
  step("stage:repair:1", "repair", [REPAIR_A]),
];

const RUNS = Array.from({ length: 30 }, (_, index) => {
  const runId = `run-${String(index + 1).padStart(2, "0")}`;
  return { runId, runDir: `${HOME}/${runId}` };
});

const CTX: KeyContext = {
  runs: RUNS.slice(0, 3),
  steps: STEPS,
  bodyHeight: 20,
  bodyWidth: 80,
  activityLines: 30,
  activityHeight: 10,
  configLines: 50,
  pagerLines: 100,
  pagerHeight: 18,
  pagerWidth: 120,
};

const K = (name: Key["name"]): Key => ({ name });
const C = (char: string): Key => ({ name: "char", char });
const CTRL_C: Key = { name: "char", char: "c", ctrl: true };

function press(state: UiState, keys: Key[], ctx: KeyContext = CTX): UiState {
  return keys.reduce((current, key) => reduce(current, key, ctx), state);
}

/** The run view of run-01 as it appears once its steps load. */
function runView(ctx: KeyContext = CTX): UiState {
  return reconcile(openRun(reconcile(initialState(), ctx), RUNS[0] as (typeof RUNS)[0]), ctx);
}

function view(state: UiState): RunViewState {
  if (state.run === null) throw new Error("no run view");
  return state.run;
}

function cursorOf(state: UiState): [Cursor | null, number, string | null] {
  const run = view(state);
  return [run.cursor, run.cursorIndex, run.expanded];
}

const at = (stepId: string, artifactId: string | null = null): Cursor => ({
  step: stepId,
  artifact: artifactId,
});

describe("runs list", () => {
  const start = (ctx: KeyContext = CTX): UiState => reconcile(initialState(), ctx);

  it("selects the first run once runs load", () => {
    expect(initialState().runs).toEqual({ selected: null, index: 0, top: 0 });
    expect(start().runs).toEqual({ selected: "run-01", index: 0, top: 0 });
  });

  it.each<[string, Key[], string, number]>([
    ["up stops at the first row", [K("up")], "run-01", 0],
    ["k stops at the first row", [C("k")], "run-01", 0],
    ["down moves", [K("down")], "run-02", 1],
    ["j moves", [C("j")], "run-02", 1],
    ["down stops at the last row", [K("down"), K("down"), K("down"), K("down")], "run-03", 2],
    ["j stops at the last row", [C("j"), C("j"), C("j"), C("j")], "run-03", 2],
    ["up after down", [K("down"), K("down"), K("up")], "run-02", 1],
    ["k after j", [C("j"), C("j"), C("k")], "run-02", 1],
    ["end selects the last row", [K("end")], "run-03", 2],
    ["home selects the first row", [K("end"), K("home")], "run-01", 0],
  ])("%s", (_name, keys, selected, index) => {
    const state = press(start(), keys);
    expect(state.screen).toBe("runs");
    expect(state.runs).toEqual({ selected, index, top: 0 });
  });

  it.each<[string, Key[], string, number]>([
    ["pgdn moves a page less one line", [K("pagedown")], "run-20", 19],
    ["pgdn stops at the last row", [K("pagedown"), K("pagedown")], "run-30", 29],
    ["pgup moves back a page", [K("pagedown"), K("pagedown"), K("pageup")], "run-11", 10],
    ["pgup stops at the first row", [K("down"), K("pageup")], "run-01", 0],
  ])("%s", (_name, keys, selected, index) => {
    const ctx = { ...CTX, runs: RUNS };
    expect(press(start(ctx), keys, ctx).runs).toEqual({ selected, index, top: 0 });
  });

  it.each<[string, Key]>([
    ["right", K("right")],
    ["enter", K("enter")],
  ])("%s opens the selected run on the Steps tab, focused on content", (_name, key) => {
    const state = reduce(press(start(), [K("down")]), key, CTX);
    expect(state.screen).toBe("run");
    expect(state.runs).toEqual({ selected: "run-02", index: 1, top: 0 });
    expect(state.run).toEqual({
      runId: "run-02",
      runDir: `${HOME}/run-02`,
      tab: "steps",
      focus: "content",
      expanded: null,
      cursor: null,
      cursorIndex: 0,
      stepsTop: 0,
      activityTop: null,
      configTop: 0,
      pager: null,
    });
  });

  it("an empty list ignores movement and open keys", () => {
    const ctx = { ...CTX, runs: [] };
    const state = reconcile(initialState(), ctx);
    for (const key of [K("up"), K("down"), K("home"), K("end"), K("right"), K("enter")]) {
      expect(reduce(state, key, ctx)).toBe(state);
    }
  });
});

describe("steps tree", () => {
  it("opening a run focuses its first step once the steps load", () => {
    const opened = openRun(reconcile(initialState(), CTX), RUNS[0] as (typeof RUNS)[0]);
    expect(view(opened).cursor).toBeNull();
    expect(cursorOf(reconcile(opened, CTX))).toEqual([at("stage:build:1"), 0, null]);
  });

  it("up/down traverse visible step rows only while every step is collapsed", () => {
    const order: Array<[Cursor, number]> = [];
    let state = runView();
    for (let i = 0; i < 5; i += 1) {
      state = reduce(state, K("down"), CTX);
      const [cursor, index] = cursorOf(state);
      order.push([cursor as Cursor, index]);
    }
    expect(order).toEqual([
      [at("stage:review:1"), 1],
      [at("check:verify:1"), 2],
      [at("stage:repair:1"), 3],
      [at("stage:repair:1"), 3],
      [at("stage:repair:1"), 3],
    ]);
    expect(cursorOf(press(state, [C("k"), C("k"), C("k"), C("k")]))).toEqual([
      at("stage:build:1"),
      0,
      null,
    ]);
  });

  it("down/up visit the expanded step's artifacts without skipping or entering hidden ones", () => {
    let state = press(runView(), [K("down"), K("right")]);
    expect(cursorOf(state)).toEqual([at("stage:review:1"), 1, "stage:review:1"]);
    const downs: Cursor[] = [];
    for (let i = 0; i < 5; i += 1) {
      state = reduce(state, C("j"), CTX);
      downs.push(view(state).cursor as Cursor);
    }
    expect(downs).toEqual([
      at("stage:review:1", REVIEW_A.id),
      at("stage:review:1", REVIEW_B.id),
      at("check:verify:1"),
      at("stage:repair:1"),
      at("stage:repair:1"),
    ]);
    const ups: Cursor[] = [];
    for (let i = 0; i < 6; i += 1) {
      state = reduce(state, K("up"), CTX);
      ups.push(view(state).cursor as Cursor);
    }
    expect(ups).toEqual([
      at("check:verify:1"),
      at("stage:review:1", REVIEW_B.id),
      at("stage:review:1", REVIEW_A.id),
      at("stage:review:1"),
      at("stage:build:1"),
      at("stage:build:1"),
    ]);
  });

  it("right expands a collapsed step, keeping it selected", () => {
    expect(cursorOf(press(runView(), [K("right")]))).toEqual([
      at("stage:build:1"),
      0,
      "stage:build:1",
    ]);
  });

  it("right on an expanded step enters its first artifact", () => {
    expect(cursorOf(press(runView(), [K("down"), K("right"), K("right")]))).toEqual([
      at("stage:review:1", REVIEW_A.id),
      2,
      "stage:review:1",
    ]);
  });

  it("right on an artifact opens it in the pager", () => {
    const state = press(runView(), [K("down"), K("right"), K("right"), K("down"), K("right")]);
    expect(view(state).pager).toEqual({ artifact: REVIEW_B, stepName: "review", top: 0, left: 0 });
    expect(cursorOf(state)).toEqual([at("stage:review:1", REVIEW_B.id), 3, "stage:review:1"]);
  });

  it("right on an expanded step with no artifacts stays", () => {
    const expanded = press(runView(), [K("down"), K("down"), K("right")]);
    expect(cursorOf(expanded)).toEqual([at("check:verify:1"), 2, "check:verify:1"]);
    expect(reduce(expanded, K("right"), CTX)).toBe(expanded);
  });

  it("left from an artifact returns to its parent, which stays expanded", () => {
    const state = press(runView(), [K("down"), K("right"), K("right"), K("down"), K("left")]);
    expect(cursorOf(state)).toEqual([at("stage:review:1"), 1, "stage:review:1"]);
    expect(view(state).pager).toBeNull();
  });

  it("left collapses an expanded step", () => {
    expect(cursorOf(press(runView(), [K("down"), K("right"), K("left")]))).toEqual([
      at("stage:review:1"),
      1,
      null,
    ]);
  });

  it("left on a collapsed root stays", () => {
    const state = press(runView(), [K("down")]);
    expect(reduce(state, K("left"), CTX)).toBe(state);
  });

  it("enter toggles the selected step", () => {
    const opened = press(runView(), [K("down"), K("enter")]);
    expect(cursorOf(opened)).toEqual([at("stage:review:1"), 1, "stage:review:1"]);
    expect(cursorOf(reduce(opened, K("enter"), CTX))).toEqual([at("stage:review:1"), 1, null]);
  });

  it("enter on an artifact opens it", () => {
    const state = press(runView(), [K("enter"), K("down"), K("enter")]);
    expect(view(state).pager).toEqual({ artifact: BUILD_A, stepName: "build", top: 0, left: 0 });
    expect(cursorOf(state)).toEqual([at("stage:build:1", BUILD_A.id), 1, "stage:build:1"]);
  });

  it.each<[string, Key[], ArtifactRef, string]>([
    ["o on a collapsed step opens its first artifact", [K("down")], REVIEW_A, "review"],
    ["o on an expanded step opens its first artifact", [K("down"), K("right")], REVIEW_A, "review"],
    [
      "o on an artifact opens that artifact",
      [K("down"), K("right"), K("right"), K("down")],
      REVIEW_B,
      "review",
    ],
    ["o on the last step opens its artifact", [K("end")], REPAIR_A, "repair"],
  ])("%s", (_name, keys, expected, stepName) => {
    const before = press(runView(), keys);
    const state = reduce(before, C("o"), CTX);
    expect(view(state).pager).toEqual({ artifact: expected, stepName, top: 0, left: 0 });
    expect(cursorOf(state)).toEqual(cursorOf(before));
  });

  it("o on a step without artifacts stays", () => {
    const state = press(runView(), [K("down"), K("down")]);
    expect(reduce(state, C("o"), CTX)).toBe(state);
  });

  it("only one step is expanded at a time", () => {
    const first = press(runView(), [K("right")]);
    expect(view(first).expanded).toBe("stage:build:1");
    const second = press(first, [K("down"), K("down"), K("right")]);
    expect(cursorOf(second)).toEqual([at("stage:review:1"), 1, "stage:review:1"]);
    // build's artifact is hidden again: up from review lands on the build row.
    expect(cursorOf(reduce(second, K("up"), CTX))).toEqual([
      at("stage:build:1"),
      0,
      "stage:review:1",
    ]);
    expect(view(press(second, [K("down"), K("down"), K("down"), K("enter")])).expanded).toBe(
      "check:verify:1",
    );
  });

  it("home/end select the first/last visible entry", () => {
    const end = press(runView(), [K("end"), K("right"), K("home"), K("end")]);
    expect(cursorOf(end)).toEqual([at("stage:repair:1", REPAIR_A.id), 4, "stage:repair:1"]);
    expect(cursorOf(reduce(end, K("home"), CTX))).toEqual([
      at("stage:build:1"),
      0,
      "stage:repair:1",
    ]);
  });

  it("pgdn/pgup move a page and stop at the ends", () => {
    const ctx = { ...CTX, bodyHeight: 3 };
    const down = press(runView(ctx), [K("pagedown")], ctx);
    expect(cursorOf(down)).toEqual([at("check:verify:1"), 2, null]);
    expect(cursorOf(press(down, [K("pagedown")], ctx))).toEqual([at("stage:repair:1"), 3, null]);
    expect(cursorOf(press(down, [K("pageup"), K("pageup")], ctx))).toEqual([
      at("stage:build:1"),
      0,
      null,
    ]);
  });
});

describe("tabs and focus", () => {
  it.each<[string, Tab]>([
    ["1", "steps"],
    ["2", "activity"],
    ["3", "config"],
  ])("%s switches to its tab from content and from the tab bar", (char, tab) => {
    for (const base of [
      runView(),
      press(runView(), [K("tab")]),
      press(runView(), [C("3")]),
      press(runView(), [C("2"), K("tab")]),
    ]) {
      const run = view(reduce(base, C(char), CTX));
      expect([run.tab, run.focus]).toEqual([tab, "content"]);
    }
  });

  it.each<[string, Key]>([
    ["tab", K("tab")],
    ["shift-tab", K("backtab")],
  ])("%s toggles focus between the tab bar and content", (_name, key) => {
    const bar = reduce(runView(), key, CTX);
    expect(view(bar).focus).toBe("tabbar");
    expect(view(reduce(bar, key, CTX)).focus).toBe("content");
  });

  it.each<[string, Key, Tab[]]>([
    ["right", K("right"), ["activity", "config", "steps"]],
    ["left", K("left"), ["config", "activity", "steps"]],
  ])("%s on the tab bar cycles the tabs", (_name, key, expected) => {
    let state = press(runView(), [K("tab")]);
    const seen: Tab[] = [];
    for (let i = 0; i < 3; i += 1) {
      state = reduce(state, key, CTX);
      seen.push(view(state).tab);
      expect(view(state).focus).toBe("tabbar");
    }
    expect(seen).toEqual(expected);
  });

  it.each<[string, Key]>([
    ["down", K("down")],
    ["enter", K("enter")],
  ])("%s on the tab bar focuses the retained step selection", (_name, key) => {
    const before = press(runView(), [K("down"), K("right"), K("right")]);
    const bar = press(before, [K("tab"), K("right"), K("left")]);
    expect(cursorOf(bar)).toEqual(cursorOf(before));
    const state = reduce(bar, key, CTX);
    expect(view(state).focus).toBe("content");
    expect(view(state).tab).toBe("steps");
    expect(cursorOf(state)).toEqual([at("stage:review:1", REVIEW_A.id), 2, "stage:review:1"]);
  });

  it("switching tabs keeps step selection and expansion", () => {
    const before = press(runView(), [K("down"), K("right"), K("right"), K("down")]);
    for (const keys of [
      [C("2"), C("1")],
      [C("3"), C("1")],
      [C("2"), K("right"), K("right")],
    ]) {
      const state = press(before, keys);
      expect(view(state).tab).toBe("steps");
      expect(cursorOf(state)).toEqual([at("stage:review:1", REVIEW_B.id), 3, "stage:review:1"]);
    }
  });

  it.each<[string, Key, Tab]>([
    ["2", K("right"), "config"],
    ["2", K("left"), "steps"],
    ["3", K("right"), "steps"],
    ["3", K("left"), "activity"],
  ])("from tab %s, %s in content switches tabs", (char, key, tab) => {
    const run = view(reduce(press(runView(), [C(char)]), key, CTX));
    expect([run.tab, run.focus]).toEqual([tab, "content"]);
  });
});

describe("activity", () => {
  // 30 lines, 10 visible: the last reading position is 20, a page is 9.
  const activity = (): UiState => press(runView(), [C("2")]);
  const top = (state: UiState): number | null => view(state).activityTop;

  it("starts following the latest activity", () => {
    expect(top(activity())).toBeNull();
    expect(top(press(activity(), [K("down")]))).toBeNull();
    expect(top(press(activity(), [K("pagedown")]))).toBeNull();
  });

  it.each<[string, Key[], number | null]>([
    ["up pauses one line above the end", [K("up")], 19],
    ["k pauses one line above the end", [C("k")], 19],
    ["end resumes following", [K("up"), K("up"), K("end")], null],
    ["scrolling down to the end resumes following", [K("up"), K("up"), K("down"), C("j")], null],
    ["down short of the end keeps reading", [K("up"), K("up"), K("down")], 19],
    ["pgup moves a page", [K("pageup")], 11],
    ["pgup clamps at the top", [K("pageup"), K("pageup"), K("pageup")], 0],
    ["home goes to the top", [K("home")], 0],
    ["up at the top stays", [K("home"), K("up")], 0],
    ["pgdn moves a page", [K("home"), K("pagedown")], 9],
    [
      "pgdn to the end resumes following",
      [K("home"), K("pagedown"), K("pagedown"), K("pagedown")],
      null,
    ],
  ])("%s", (_name, keys, expected) => {
    expect(top(press(activity(), keys))).toBe(expected);
  });

  it("a document shorter than the body keeps following", () => {
    const ctx = { ...CTX, activityLines: 4 };
    const state = press(runView(ctx), [C("2"), K("up"), K("home"), K("pageup")], ctx);
    expect(top(state)).toBeNull();
  });
});

describe("config", () => {
  // 50 lines, 20 visible: the last reading position is 30, a page is 19.
  it.each<[string, Key[], number]>([
    ["starts at the top", [], 0],
    ["up clamps at the top", [K("up")], 0],
    ["down scrolls a line", [K("down"), C("j")], 2],
    ["pgdn scrolls a page", [K("pagedown")], 19],
    ["space scrolls a page", [C(" ")], 19],
    ["pgdn clamps at the end", [K("pagedown"), K("pagedown")], 30],
    ["end goes to the end", [K("end")], 30],
    ["down clamps at the end", [K("end"), K("down")], 30],
    ["pgup scrolls back a page", [K("end"), K("pageup")], 11],
    ["pgup clamps at the top", [K("end"), K("pageup"), K("pageup")], 0],
    ["home goes to the top", [K("end"), K("home")], 0],
  ])("%s", (_name, keys, expected) => {
    expect(view(press(runView(), [C("3"), ...keys])).configTop).toBe(expected);
  });
});

describe("pager", () => {
  const origin = (): UiState => press(runView(), [K("down"), K("right"), K("right"), K("down")]);
  const pager = (): UiState => reduce(origin(), K("right"), CTX);
  const position = (state: UiState): [number, number] => {
    const open = view(state).pager;
    if (open === null) throw new Error("pager closed");
    return [open.top, open.left];
  };

  it("esc restores the exact originating entry", () => {
    const before = origin();
    const state = press(pager(), [K("pagedown"), K("right"), K("down"), K("up"), K("escape")]);
    expect(state.screen).toBe("run");
    expect(view(state).pager).toBeNull();
    expect(view(state)).toEqual(view(before));
  });

  // 100 lines, 18 visible: the last position is 82, a page is 17.
  it.each<[string, Key[], number]>([
    ["up clamps at the top", [K("up")], 0],
    ["down scrolls a line", [K("down"), C("j")], 2],
    ["pgdn scrolls a page", [K("pagedown")], 17],
    ["end goes to the end", [K("end")], 82],
    ["down clamps at the end", [K("end"), K("down")], 82],
    ["pgdn clamps at the end", [K("end"), K("pageup"), K("pagedown"), K("pagedown")], 82],
    ["pgup scrolls back a page", [K("end"), K("pageup")], 65],
    ["home goes to the top", [K("end"), K("home")], 0],
  ])("%s", (_name, keys, expected) => {
    const state = press(pager(), keys);
    expect(position(state)).toEqual([expected, 0]);
    expect(cursorOf(state)).toEqual(cursorOf(origin()));
  });

  // 120 columns wide in an 80-column body: panning stops at 40.
  it.each<[string, Key[], number]>([
    ["left clamps at the first column", [K("left")], 0],
    ["right pans 8 columns", [K("right")], 8],
    ["right clamps at the widest line", [...Array<Key>(6).fill(K("right"))], 40],
    ["left pans back 8 columns", [...Array<Key>(6).fill(K("right")), K("left")], 32],
  ])("%s", (_name, keys, expected) => {
    expect(position(press(pager(), keys))).toEqual([0, expected]);
  });

  it("content no wider than the body does not pan", () => {
    const ctx = { ...CTX, pagerWidth: 60 };
    const state = reduce(origin(), K("right"), ctx);
    expect(reduce(state, K("right"), ctx)).toBe(state);
  });
});

describe("leaving, quitting and help", () => {
  it("esc in the run view returns to the runs list at the same position", () => {
    const opened = press(reconcile(initialState(), CTX), [K("down"), K("enter")]);
    const state = reduce(reconcile(opened, CTX), K("escape"), CTX);
    expect(state.screen).toBe("runs");
    expect(state.run).toBeNull();
    expect(state.runs).toEqual({ selected: "run-02", index: 1, top: 0 });
  });

  const screens: Array<[string, () => UiState]> = [
    ["runs", () => reconcile(initialState(), CTX)],
    ["steps", () => runView()],
    ["tab bar", () => press(runView(), [K("tab")])],
    ["activity", () => press(runView(), [C("2")])],
    ["config", () => press(runView(), [C("3")])],
    ["pager", () => press(runView(), [C("o")])],
    ["help", () => press(runView(), [C("?")])],
    ["help over runs", () => press(reconcile(initialState(), CTX), [C("?")])],
  ];

  it.each(screens)("q and ctrl-c quit from %s", (_name, make) => {
    for (const key of [C("q"), CTRL_C]) {
      const before = make();
      const state = reduce(before, key, CTX);
      expect(state.quit).toBe(true);
      expect({ ...state, quit: false }).toEqual(before);
    }
  });

  it.each<[string, Key]>([
    ["?", C("?")],
    ["esc", K("escape")],
  ])("? opens help and %s closes it, keeping the view", (_name, key) => {
    const before = press(runView(), [K("down"), K("right")]);
    const help = reduce(before, C("?"), CTX);
    expect(help.help).toBe(true);
    const closed = reduce(help, key, CTX);
    expect(closed).toEqual(before);
  });

  it("keys other than q, esc and ? are ignored while help is open", () => {
    const help = press(runView(), [C("?")]);
    for (const key of [
      K("up"),
      K("down"),
      K("left"),
      K("right"),
      K("enter"),
      K("tab"),
      K("home"),
      K("end"),
      K("pagedown"),
      C("j"),
      C("o"),
      C("2"),
    ]) {
      expect(reduce(help, key, CTX)).toBe(help);
    }
  });
});

describe("reconcile", () => {
  it("keeps the selected step by id when steps are inserted before it", () => {
    const before = press(runView(), [K("down"), K("down")]);
    const steps = [step("stage:plan:1", "plan"), step("stage:setup:1", "setup"), ...STEPS];
    expect(cursorOf(reconcile(before, { ...CTX, steps }))).toEqual([at("check:verify:1"), 4, null]);
  });

  it("keeps a selected artifact by id when steps are inserted before it", () => {
    const before = press(runView(), [K("down"), K("right"), K("right"), K("down")]);
    const steps = [step("stage:plan:1", "plan"), ...STEPS];
    expect(cursorOf(reconcile(before, { ...CTX, steps }))).toEqual([
      at("stage:review:1", REVIEW_B.id),
      4,
      "stage:review:1",
    ]);
  });

  it("selects the entry at the former index when the selected step id disappears", () => {
    const pending = [STEPS[0], STEPS[1], step("pending:verify", "verify")] as StepNode[];
    const ctx = { ...CTX, steps: pending };
    const before = press(runView(ctx), [K("end")], ctx);
    expect(cursorOf(before)).toEqual([at("pending:verify"), 2, null]);
    const steps = [STEPS[0], STEPS[1], step("check:verify:2", "verify 2")] as StepNode[];
    expect(cursorOf(reconcile(before, { ...CTX, steps }))).toEqual([at("check:verify:2"), 2, null]);
  });

  it("clears an expanded step id that disappears", () => {
    const before = press(runView(), [K("down"), K("right"), K("right")]);
    expect(cursorOf(before)).toEqual([at("stage:review:1", REVIEW_A.id), 2, "stage:review:1"]);
    const steps = [STEPS[0], STEPS[2], STEPS[3]] as StepNode[];
    expect(cursorOf(reconcile(before, { ...CTX, steps }))).toEqual([at("stage:repair:1"), 2, null]);
  });

  it("leaves selection and expansion unchanged when nothing moved", () => {
    const state = press(runView(), [K("down"), K("right"), K("right")]);
    expect(reconcile(state, CTX)).toEqual(state);
  });

  it("keeps the selected run by id when a new run is prepended", () => {
    const before = press(reconcile(initialState(), CTX), [K("down")]);
    const runs = [{ runId: "run-new", runDir: `${HOME}/run-new` }, ...RUNS.slice(0, 3)];
    expect(reconcile(before, { ...CTX, runs }).runs).toEqual({
      selected: "run-02",
      index: 2,
      top: 0,
    });
  });

  it.each<[string, number, string[], string, number]>([
    ["a middle run", 1, ["run-01", "run-03"], "run-03", 1],
    ["the last run", 2, ["run-01", "run-02"], "run-02", 1],
  ])("falls back by index when %s is removed", (_name, downs, ids, selected, index) => {
    const before = press(reconcile(initialState(), CTX), Array<Key>(downs).fill(K("down")));
    const runs = ids.map((runId) => ({ runId, runDir: `${HOME}/${runId}` }));
    expect(reconcile(before, { ...CTX, runs }).runs).toEqual({ selected, index, top: 0 });
  });

  it("clears the run selection when the list empties", () => {
    const before = press(reconcile(initialState(), CTX), [K("down")]);
    expect(reconcile(before, { ...CTX, runs: [] }).runs).toEqual({
      selected: null,
      index: 0,
      top: 0,
    });
  });
});
