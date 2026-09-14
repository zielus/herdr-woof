// Scheduler scenarios in a real child process: node scheduler-scenarios.mjs <name> <tmp-dir>
// Builds a temporary git repository, admits the built-in build-review workflow,
// opens the run and drives it with the scripted runtime. Scripted workers act on
// the observe that follows a delivered prompt: they read their open attempt from
// the snapshot, write an artifact and submit through the real submission path.
// Prints one JSON report line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const load = (rel) => import(pathToFileURL(join(root, "dist", rel)).href);
const { runWorkflow } = await load("scheduler/driver.js");
const { admitWorkflow } = await load("scheduler/admission.js");
const { buildReviewWorkflow } = await load("workflows/build-review.js");
const { openRun } = await load("state/store.js");
const { readSnapshot } = await load("state/snapshot.js");
const { submitResult } = await load("submission/submit.js");
const { herdrRuntimeName } = await load("runtime/names.js");
const { createScriptedRuntime } = await load("testing.js");

const [name, tmp] = process.argv.slice(2);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function git(repo, ...args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Woof Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: repo, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/**
 * Runs one scenario. `workers.<agentId>(ctx)` returns what the worker does for
 * that delivery: { verdict, status, content, badSha, submit: false, edit(repo), twice }.
 */
async function scenario(options) {
  const runId = `sc-${name}`;
  const repo = join(tmp, "repo");
  const runDir = join(tmp, "run");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const names = {
    builder: herdrRuntimeName(runId, "builder"),
    reviewer: herdrRuntimeName(runId, "reviewer"),
  };
  const agentOf = Object.fromEntries(
    Object.entries(names).map(([agentId, runtimeName]) => [runtimeName, agentId]),
  );
  const defaultScript = () => ({
    timeline: [{ status: "idle", stateChangeSeq: 1 }],
    afterDeliver: [
      { status: "working", stateChangeSeq: 2 },
      { status: "idle", stateChangeSeq: 3 },
    ],
  });
  const runtime = createScriptedRuntime({
    agents: {
      [names.builder]: { ...defaultScript(), ...options.runtime?.builder },
      [names.reviewer]: { ...defaultScript(), ...options.runtime?.reviewer },
    },
  });

  const counts = { builder: 0, reviewer: 0 };
  const submissions = [];
  const pending = new Map();
  const context = { runDir, repo, runId, names, runtime, submissions };

  async function work(agentId, text) {
    const snapshot = readSnapshot(runDir);
    const active = snapshot.ok
      ? snapshot.snapshot.agents.find((agent) => agent.agentId === agentId)?.activeAttempt
      : null;
    if (active == null) return;
    counts[agentId] += 1;
    const plan =
      options.workers[agentId]({ ...active, count: counts[agentId], text, ...context }) ?? {};
    plan.edit?.(repo);
    if (plan.submit === false) return;
    const file = active.stageId === "review" ? "review.md" : "completion.md";
    const rel = `artifacts/${active.stageId}/visit-${active.visit}/attempt-${active.attempt}/${file}`;
    const content =
      plan.content ??
      `# ${active.stageId} visit ${active.visit} attempt ${active.attempt}\n\n${plan.note ?? "Work done."}\n`;
    writeFileSync(join(runDir, rel), content);
    const envelope = {
      schemaVersion: 1,
      runId,
      agentId,
      stageId: active.stageId,
      visit: active.visit,
      attempt: active.attempt,
      status: plan.status ?? "completed",
      verdict: plan.verdict ?? null,
      artifact: { path: rel, sha256: plan.badSha === true ? "0".repeat(64) : sha256(content) },
    };
    for (let round = 0; round < (plan.twice === true ? 2 : 1); round += 1) {
      const out = await submitResult({ runDir, envelopeRaw: JSON.stringify(envelope) });
      submissions.push({ agentId, ...active, outcome: out.outcome, reason: out.reason ?? null });
    }
  }

  const wrapped = {
    adapter: "scripted",
    openPane: (input) => runtime.openPane(input),
    startAgent: (input) => runtime.startAgent(input),
    waitFor: (handle, states, timeoutMs) => runtime.waitFor(handle, states, timeoutMs),
    stop: (handle, input) => runtime.stop(handle, input),
    async deliver(handle, text, input) {
      const result = await runtime.deliver(handle, text, input);
      if (runtime.calls().at(-1)?.args.sent === true) pending.set(handle.runtimeName, text);
      return result;
    },
    async observe(handle) {
      const text = pending.get(handle.runtimeName);
      if (text !== undefined) {
        pending.delete(handle.runtimeName);
        await work(agentOf[handle.runtimeName], text);
        if (options.idleAfterWork !== false) runtime.advance(handle.runtimeName);
      }
      await options.onObserve?.(handle, context);
      return runtime.observe(handle);
    },
  };

  const rawInput = {
    schemaVersion: 1,
    repo,
    task: {
      title: "Implement the fixture change",
      description: "Change the fixture repository.",
      acceptanceCriteria: ["the change exists"],
    },
    ...(options.verify === false
      ? {}
      : {
          verify: options.verify ?? {
            command: ["node", "-e", "process.exit(0)"],
            timeoutMs: 20000,
          },
        }),
    agents: {
      builder: { kind: "claude", model: null, args: [] },
      reviewer: { kind: "claude", model: "sonnet", args: ["--permission-mode", "auto"] },
    },
    limits: {
      maxAttemptsPerVisit: 2,
      maxVisitsPerStage: 3,
      maxRounds: 3,
      maxFormatRepairs: 2,
      runTimeoutMs: 60_000,
      readinessWaitMs: 10_000,
      blockedWaitMs: 10_000,
      deliveryTimeoutMs: 10_000,
      ...options.limits,
    },
  };
  const admitted = await admitWorkflow({
    definition: buildReviewWorkflow,
    input: rawInput,
    runDir,
  });
  if (!admitted.ok) throw new Error(`admission refused: ${JSON.stringify(admitted)}`);
  const opened = await openRun({ runDir, runId, plan: admitted.plan, input: rawInput });
  if (opened.outcome !== "recorded") throw new Error(`openRun refused: ${JSON.stringify(opened)}`);

  const controller = new AbortController();
  context.abort = () => controller.abort();
  const out = await runWorkflow({
    runDir,
    definition: buildReviewWorkflow,
    input: admitted.input,
    runtime: wrapped,
    submitCommand: [process.execPath, join(root, "dist", "cli.js")],
    signal: controller.signal,
    pollMs: options.pollMs ?? 2,
  });
  await options.after?.(context);

  const journal = readFileSync(join(runDir, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  const requests = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        requests.push({
          path: relative(runDir, path),
          text: readFileSync(path, "utf8"),
          sha256: sha256(readFileSync(path)),
        });
    }
  };
  try {
    walk(join(runDir, "requests"));
  } catch {
    // No request was written.
  }
  const snapshot = readSnapshot(runDir);
  return {
    result: out.result,
    error: out.error,
    stats: out.stats,
    journal,
    types: journal.map((record) => record.type),
    calls: runtime.calls().map((call) => ({
      method: call.method,
      runtimeName: call.runtimeName,
      args:
        call.args.text === undefined ? call.args : { ...call.args, text: sha256(call.args.text) },
    })),
    requests,
    submissions,
    snapshot: snapshot.ok ? snapshot.snapshot : null,
    names,
    runDir,
    repo,
  };
}

const edit = (content) => (repo) => {
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "change.txt"), content);
};

const SCENARIOS = {
  happy: () =>
    scenario({
      workers: {
        builder: ({ count }) => ({ edit: edit(`version ${count}\n`) }),
        reviewer: ({ count }) => ({
          verdict: count === 1 ? "fail" : "pass",
          note: count === 1 ? "Blocking: add the header line." : "Looks good.",
        }),
      },
    }),
};

const run = SCENARIOS[name];
if (run === undefined) {
  console.error(`unknown scenario ${name}`);
  process.exit(2);
}
console.log(JSON.stringify(await run()));
