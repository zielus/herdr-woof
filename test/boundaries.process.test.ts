import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/process.js";

// Module boundaries (plan D8), checked on the compiled output that ships.
const dist = join(repoRoot, "dist");

function files(dir: string, suffix: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Static and literal dynamic import specifiers of a compiled module. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  }
  return found;
}

/** dist-relative module path → the dist-relative paths it imports (node: builtins excluded). */
function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of files(dist, ".js")) {
    const from = relative(dist, file).split("\\").join("/");
    const imports: string[] = [];
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        imports.push(`package:${specifier}`);
        continue;
      }
      imports.push(posix.normalize(posix.join(posix.dirname(from), specifier)));
    }
    graph.set(from, imports);
  }
  return graph;
}

const area = (path: string) => (path.includes("/") ? (path.split("/")[0] as string) : path);

/** The most specific rule: an exact module, then a two-segment area, then the top-level area. */
function ruleFor(path: string): { areas: string[]; modules?: string[] } | undefined {
  const segments = path.split("/");
  return (
    RULES[path] ??
    (segments.length > 2 ? RULES[segments.slice(0, 2).join("/")] : undefined) ??
    RULES[area(path)]
  );
}

// Allowed target areas per source area. Exceptions are listed by exact module.
const RULES: Record<string, { areas: string[]; modules?: string[] }> = {
  // p4 (plan D13): configuration reads files and the built-in catalog; nothing in the engine imports it.
  config: {
    areas: ["config", "contracts", "domain"],
    modules: [
      "scheduler/definition.js",
      "scheduler/loader.js",
      "scheduler/launch.js",
      "workflows/catalog.js",
      "runtime/claude/trust.js",
    ],
  },
  "runtime/claude": { areas: ["contracts"] },
  // The run host claims runs, resolves configuration and drives the scheduler.
  host: {
    areas: ["host", "contracts", "domain", "state", "observe", "scheduler", "config"],
    modules: ["runtime/herdr/exec.js"],
  },
  // A pure file probe the snapshot reader may import.
  "host/probe.js": { areas: ["contracts"] },
  inspect: {
    areas: ["inspect", "state", "observe", "contracts", "domain"],
    modules: ["host/probe.js", "host/files.js"],
  },
  // Command handlers may import any area; only cli.ts imports them (checked below).
  commands: {
    areas: [
      "commands",
      "config",
      "contracts",
      "domain",
      "host",
      "inspect",
      "journal",
      "observe",
      "runtime",
      "scheduler",
      "state",
      "submission",
      "workflows",
    ],
    modules: ["version.js"],
  },
  contracts: { areas: ["contracts"] },
  domain: { areas: ["domain", "contracts"] },
  runtime: { areas: ["runtime", "domain", "contracts"] },
  journal: { areas: ["journal", "contracts", "domain"], modules: ["state/reducer.js"] },
  state: { areas: ["state", "domain", "contracts", "journal"], modules: ["host/probe.js"] },
  observe: { areas: ["observe", "state", "journal", "contracts"] },
  submission: { areas: ["submission", "contracts", "journal", "state"] },
  // p3 (plan D15): the scheduler reads state and runtime, writes through the store and
  // openAttempt, and re-hashes accepted copies; it never reaches the journal file or observe/.
  scheduler: {
    areas: ["scheduler", "domain", "contracts", "state", "runtime"],
    modules: ["submission/attempt.js", "journal/accepted-copy.js"],
  },
  workflows: { areas: ["workflows", "scheduler", "domain", "contracts"] },
};

describe("module boundaries in dist", () => {
  const graph = importGraph();

  it("finds the compiled modules", () => {
    expect(graph.size).toBeGreaterThan(25);
    for (const module of [
      "index.js",
      "testing.js",
      "cli.js",
      "state/reducer.js",
      "runtime/herdr/adapter.js",
      "scheduler/driver.js",
      "workflows/build-review.js",
    ]) {
      expect(graph.has(module), module).toBe(true);
    }
  });

  it("follows the one-way import rules and imports no packages", () => {
    const violations: string[] = [];
    for (const [from, imports] of graph) {
      for (const target of imports) {
        if (target.startsWith("package:")) {
          violations.push(`${from} imports ${target}`);
          continue;
        }
        if (!graph.has(target)) violations.push(`${from} imports missing ${target}`);
        const rule = ruleFor(from);
        if (rule === undefined) continue; // index.js, testing.js, cli.js, version.js
        if (!rule.areas.includes(area(target)) && !(rule.modules ?? []).includes(target)) {
          violations.push(`${from} imports ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps cli.js unreachable from the entry points and imported by nothing", () => {
    const reachable = (start: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const next = stack.pop() as string;
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(...(graph.get(next) ?? []));
      }
      return seen;
    };
    expect(reachable("index.js").has("cli.js")).toBe(false);
    expect(reachable("testing.js").has("cli.js")).toBe(false);
    expect(reachable("index.js").has("runtime/scripted.js")).toBe(false);
    expect([...graph].filter(([, imports]) => imports.includes("cli.js"))).toEqual([]);
  });

  it("lets only the entry points, commands, the host, configuration, the scheduler and workflows import scheduler/ and workflows/", () => {
    const allowed = new Set([
      "index.js",
      "cli.js",
      "scheduler",
      "workflows",
      "config",
      "host",
      "commands",
    ]);
    const violations = [...graph].flatMap(([from, imports]) =>
      imports
        .filter((target) => ["scheduler", "workflows"].includes(area(target)))
        .filter(() => !allowed.has(from) && !allowed.has(area(from)))
        .map((target) => `${from} imports ${target}`),
    );
    expect(violations).toEqual([]);
  });

  it("lets only cli.ts and other command handlers import commands/", () => {
    const violations = [...graph].flatMap(([from, imports]) =>
      imports
        .filter((target) => area(target) === "commands")
        .filter(() => from !== "cli.js" && area(from) !== "commands")
        .map((target) => `${from} imports ${target}`),
    );
    expect(violations).toEqual([]);
  });

  it("never names the .woof configuration directory in the engine areas (nothing after openRun reads it)", () => {
    const found: string[] = [];
    for (const dir of ["scheduler", "state", "journal", "observe"]) {
      for (const file of files(join(dist, dir), ".js")) {
        if (readFileSync(file, "utf8").includes(".woof")) found.push(relative(dist, file));
      }
    }
    expect(found).toEqual([]);
  });

  it("names no built-in stage and appends no journal record in dist/scheduler", () => {
    const found: string[] = [];
    for (const file of files(join(dist, "scheduler"), ".js")) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/["'`](build|verify|review|repair)["'`]/g)) {
        found.push(`${relative(dist, file)}: ${match[0]}`);
      }
      if (source.includes("appendRecord")) found.push(`${relative(dist, file)}: appendRecord`);
    }
    expect(files(join(dist, "scheduler"), ".js").length).toBeGreaterThan(5);
    expect(found).toEqual([]);
  });

  it("loads the entry points in a real process without running the CLI", () => {
    // cli.js prints usage when evaluated, so any transitive load would show on stdout.
    const script = `await import(${JSON.stringify(pathToFileURL(join(dist, "index.js")).href)});
await import(${JSON.stringify(pathToFileURL(join(dist, "testing.js")).href)});`;
    const result = spawnSync("node", ["--input-type=module", "--eval", script], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("test import rules", () => {
  it("never imports src/ from tests, and unit tests load only compiled dist/", () => {
    const violations: string[] = [];
    for (const file of files(join(repoRoot, "test"), ".ts")) {
      const rel = relative(repoRoot, file);
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiers(source)) {
        if (/(^|\/)src\//.test(specifier)) violations.push(`${rel}: ${specifier}`);
        if (dirname(rel).endsWith("unit")) {
          const allowed =
            specifier === "vitest" ||
            specifier.startsWith("node:") ||
            specifier === "../helpers/dist.js" ||
            specifier === "../helpers/records.js";
          if (!allowed) violations.push(`${rel}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
