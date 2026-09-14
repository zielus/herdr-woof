// Scheduler scenarios in a real child process: node scheduler-scenarios.mjs <name> <tmp-dir>
// Builds a temporary git repository, admits a workflow (the built-in build-review
// unless the scenario loads another definition), opens the run and drives it with
// the scripted runtime. Scripted workers act on an observe that follows a
// delivered prompt: they read their open attempt from the snapshot, write an
// artifact and submit through the real submission path. Prints one JSON report.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const distUrl = (rel) => pathToFileURL(join(root, "dist", rel)).href;
const load = (rel) => import(distUrl(rel));
const { runWorkflow } = await load("scheduler/driver.js");
const { admitWorkflow } = await load("scheduler/admission.js");
const { loadWorkflowDefinition } = await load("scheduler/loader.js");
const { buildReviewWorkflow } = await load("workflows/build-review.js");
const { openRun } = await load("state/store.js");
const { readSnapshot } = await load("state/snapshot.js");
const { submitResult } = await load("submission/submit.js");
const { herdrRuntimeName } = await load("runtime/names.js");
const { revisionOf } = await load("scheduler/revision.js");
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

const journalOf = (runDir) =>
  readFileSync(join(runDir, "journal.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

/**
 * Options:
 * - workers.<agentId>(ctx) → { verdict, status, content, badSha, submit: false, edit(repo), twice, late: {attempt, verdict} }
 * - runtime.<agentId>: ScriptedAgent overrides
 * - idleAfterWork(agentId) → boolean (default true): advance the timeline after the worker acted
 * - skipObserves(agentId) → n: observes to let pass (advancing the timeline) before the worker acts
 * - submitInDeliver(agentId) → boolean: the worker submits inside deliver, before it returns
 * - onObserve(handle, context), after(context), onAction(action, context) (sync, before each action runs)
 * - verify: false | {command, timeoutMs}; limits: overrides
 * - definitionPath, makeInput(repo): another workflow
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

  let definition = buildReviewWorkflow;
  if (options.definitionPath !== undefined) {
    const loaded = await loadWorkflowDefinition(options.definitionPath);
    if (!loaded.ok) throw new Error(`definition refused: ${JSON.stringify(loaded)}`);
    definition = loaded.definition;
  }
  if (options.wrapDefinition !== undefined) definition = options.wrapDefinition(definition);
  const agentIds = definition.agents.map((agent) => agent.agentId);
  const names = Object.fromEntries(
    agentIds.map((agentId) => [agentId, herdrRuntimeName(runId, agentId)]),
  );
  const agentOf = Object.fromEntries(agentIds.map((agentId) => [names[agentId], agentId]));
  const runtime = createScriptedRuntime({
    agents: Object.fromEntries(
      agentIds.map((agentId) => [
        names[agentId],
        {
          timeline: [{ status: "idle", stateChangeSeq: 1 }],
          afterDeliver: [
            { status: "working", stateChangeSeq: 2 },
            { status: "idle", stateChangeSeq: 3 },
          ],
          ...options.runtime?.[agentId],
        },
      ]),
    ),
  });

  const counts = Object.fromEntries(agentIds.map((agentId) => [agentId, 0]));
  const submissions = [];
  const pending = new Map();
  const context = {
    runDir,
    repo,
    runId,
    names,
    runtime,
    submissions,
    marks: {},
    journal: () => journalOf(runDir),
  };

  const artifactFor = (stageId) =>
    definition.stages.find((stage) => stage.kind === "agent" && stage.stageId === stageId)
      ?.artifactFile ?? "out.md";

  async function submit(agentId, identity, plan) {
    const rel = `artifacts/${identity.stageId}/visit-${identity.visit}/attempt-${identity.attempt}/${artifactFor(identity.stageId)}`;
    const content =
      plan.content ??
      `# ${identity.stageId} visit ${identity.visit} attempt ${identity.attempt}\n\n${plan.note ?? "Work done."}\n`;
    mkdirSync(dirname(join(runDir, rel)), { recursive: true });
    writeFileSync(join(runDir, rel), content);
    const envelope = {
      schemaVersion: 1,
      runId,
      agentId,
      stageId: identity.stageId,
      visit: identity.visit,
      attempt: identity.attempt,
      status: plan.status ?? "completed",
      verdict: plan.verdict ?? null,
      artifact: { path: rel, sha256: plan.badSha === true ? "0".repeat(64) : sha256(content) },
    };
    for (let round = 0; round < (plan.twice === true ? 2 : 1); round += 1) {
      const out = await submitResult({ runDir, envelopeRaw: JSON.stringify(envelope) });
      submissions.push({ agentId, ...identity, outcome: out.outcome, reason: out.reason ?? null });
    }
  }
  context.submit = submit;

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
    if (plan.late !== undefined) {
      await submit(
        agentId,
        { ...active, attempt: plan.late.attempt },
        { verdict: plan.late.verdict, note: "late" },
      );
    }
    if (plan.submit === false) return;
    await submit(agentId, active, plan);
  }

  const wrapped = {
    adapter: "scripted",
    openPane: (input) => runtime.openPane(input),
    startAgent: (input) => runtime.startAgent(input),
    waitFor: (handle, states, timeoutMs) => runtime.waitFor(handle, states, timeoutMs),
    stop: (handle, input) => runtime.stop(handle, input),
    async deliver(handle, text, input) {
      // A fast worker submits while the prompt is still being delivered.
      if (options.submitInDeliver?.(agentOf[handle.runtimeName]) === true) {
        await work(agentOf[handle.runtimeName], text);
      }
      const result = await runtime.deliver(handle, text, input);
      if (runtime.calls().at(-1)?.args.sent === true) {
        pending.set(handle.runtimeName, {
          text,
          skip: options.skipObserves?.(agentOf[handle.runtimeName]) ?? 0,
        });
      }
      return result;
    },
    async observe(handle) {
      const agentId = agentOf[handle.runtimeName];
      const job = pending.get(handle.runtimeName);
      if (job !== undefined && job.skip > 0) {
        job.skip -= 1;
        runtime.advance(handle.runtimeName);
      } else if (job !== undefined) {
        pending.delete(handle.runtimeName);
        await work(agentId, job.text);
        if (options.idleAfterWork?.(agentId) !== false) runtime.advance(handle.runtimeName);
      }
      await options.onObserve?.(handle, { ...context, agentId });
      return runtime.observe(handle);
    },
  };

  const rawInput = options.makeInput?.(repo) ?? {
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
  const admitted = await admitWorkflow({ definition, input: rawInput, runDir });
  if (!admitted.ok) throw new Error(`admission refused: ${JSON.stringify(admitted)}`);
  const opened = await openRun({ runDir, runId, plan: admitted.plan, input: rawInput });
  if (opened.outcome !== "recorded") throw new Error(`openRun refused: ${JSON.stringify(opened)}`);

  const controller = new AbortController();
  context.abort = () => controller.abort();
  const startedAt = Date.now();
  const out = await runWorkflow({
    runDir,
    definition,
    input: admitted.input,
    repository: admitted.repository,
    runtime: wrapped,
    submitCommand: [process.execPath, join(root, "dist", "cli.js")],
    signal: controller.signal,
    pollMs: options.pollMs ?? 2,
    onAction: (action) => options.onAction?.(action, context),
  });
  const elapsedMs = Date.now() - startedAt;
  await options.after?.(context);

  const journal = journalOf(runDir);
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
  if (existsSync(join(runDir, "requests"))) walk(join(runDir, "requests"));
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
    finalRevision: await revisionOf(repo),
    elapsedMs,
    marks: context.marks,
    names,
    runDir,
    repo,
  };
}

const edit = (content) => (repo) => {
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "change.txt"), content);
};
const builderEdits = ({ count }) => ({ edit: edit(`version ${count}\n`) });
const once = (context, key) => {
  if (context.marks[key] === true) return false;
  context.marks[key] = true;
  return true;
};

const SCENARIOS = {
  happy: () =>
    scenario({
      workers: {
        builder: builderEdits,
        reviewer: ({ count }) => ({
          verdict: count === 1 ? "fail" : "pass",
          note: count === 1 ? "Blocking: add the header line." : "Looks good.",
        }),
      },
    }),

  "bad-submission": () =>
    scenario({
      workers: {
        builder: builderEdits,
        // Attempt 1 claims pass with a wrong hash; the format repair submits a valid fail; round 2 passes.
        reviewer: ({ count }) =>
          count === 1
            ? { verdict: "pass", badSha: true }
            : { verdict: count === 2 ? "fail" : "pass" },
      },
    }),

  "no-submission": () =>
    scenario({
      verify: false,
      workers: {
        builder: ({ count }) => (count === 1 ? { submit: false } : { edit: edit("built\n") }),
        reviewer: () => ({ verdict: "pass" }),
      },
    }),

  "revision-moved": () =>
    scenario({
      verify: false,
      workers: {
        builder: builderEdits,
        reviewer: ({ count, repo }) => ({
          verdict: "pass",
          // Review 1 changes the repository before it passes; the change is gone again before review 2.
          edit:
            count === 1
              ? () => writeFileSync(join(repo, "stray.txt"), "reviewer edit\n")
              : undefined,
        }),
      },
      onObserve: (_handle, context) => {
        const moved = context
          .journal()
          .some((record) => record.type === "gate.recorded" && record.reason === "revision_moved");
        const stray = join(context.repo, "stray.txt");
        if (moved && existsSync(stray)) rmSync(stray);
      },
    }),

  "late-older-pass": () =>
    scenario({
      verify: false,
      workers: {
        builder: builderEdits,
        reviewer: ({ count }) =>
          count === 1
            ? { submit: false }
            : count === 2
              ? { late: { attempt: 1, verdict: "pass" }, verdict: "fail" }
              : { verdict: "pass" },
      },
    }),

  "max-rounds": () =>
    scenario({
      verify: false,
      limits: { maxRounds: 2 },
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "fail" }) },
    }),

  "max-visits": () =>
    scenario({
      verify: { command: ["node", "-e", "process.exit(1)"], timeoutMs: 20000 },
      limits: { maxVisitsPerStage: 2 },
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
    }),

  "max-format-repairs": () =>
    scenario({
      verify: false,
      limits: { maxFormatRepairs: 1 },
      workers: { builder: () => ({ submit: false }), reviewer: () => ({ verdict: "pass" }) },
    }),

  "max-attempts": () =>
    scenario({
      verify: false,
      runtime: { builder: { onDeliver: "not_delivered:agent_busy" } },
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
    }),

  "readiness-timeout": () =>
    scenario({
      verify: false,
      limits: { readinessWaitMs: 300 },
      runtime: { builder: { timeline: [{ status: "working", stateChangeSeq: 1 }] } },
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
    }),

  "blocked-timeout": () =>
    scenario({
      verify: false,
      limits: { blockedWaitMs: 300 },
      runtime: { builder: { afterDeliver: [{ status: "blocked", stateChangeSeq: 2 }] } },
      idleAfterWork: () => false,
      workers: { builder: () => ({ submit: false }), reviewer: () => ({ verdict: "pass" }) },
    }),

  "delivery-timeout": () =>
    scenario({
      verify: false,
      limits: { deliveryTimeoutMs: 300 },
      runtime: { builder: { onDeliver: "ambiguous:stalled" } },
      idleAfterWork: () => false,
      workers: { builder: () => ({ submit: false }), reviewer: () => ({ verdict: "pass" }) },
    }),

  "run-timeout": () =>
    scenario({
      verify: false,
      limits: { runTimeoutMs: 600 },
      runtime: { builder: { afterDeliver: [{ status: "working", stateChangeSeq: 2 }] } },
      idleAfterWork: () => false,
      workers: { builder: () => ({ submit: false }), reviewer: () => ({ verdict: "pass" }) },
    }),

  "blocked-resolved": () =>
    scenario({
      verify: false,
      runtime: {
        reviewer: {
          afterDeliver: [
            { status: "blocked", stateChangeSeq: 2 },
            { status: "working", stateChangeSeq: 3 },
            { status: "idle", stateChangeSeq: 4 },
          ],
        },
      },
      idleAfterWork: (agentId) => agentId !== "reviewer",
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
      onObserve: (handle, context) => {
        if (context.agentId !== "reviewer") return;
        const snapshot = readSnapshot(context.runDir);
        if (
          snapshot.ok &&
          snapshot.snapshot.attention.blocked !== null &&
          once(context, "blocked")
        ) {
          context.marks.blockedSnapshot = snapshot.snapshot;
          context.runtime.advance(handle.runtimeName);
        }
      },
    }),

  "ambiguous-delivered": () =>
    scenario({
      verify: false,
      runtime: { builder: { onDeliver: ["ambiguous:timeout", "started"] } },
      skipObserves: (agentId) => (agentId === "builder" ? 1 : 0),
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
    }),

  "cancel-abort": () =>
    scenario({
      verify: false,
      idleAfterWork: (agentId) => agentId !== "reviewer",
      workers: { builder: builderEdits, reviewer: () => ({ submit: false }) },
      onObserve: (_handle, context) => {
        if (context.agentId === "reviewer" && once(context, "abort")) context.abort();
      },
      after: async (context) => {
        await context.submit(
          "reviewer",
          { stageId: "review", visit: 1, attempt: 1 },
          { verdict: "pass", note: "late" },
        );
      },
    }),

  "cancel-external": () =>
    scenario({
      verify: false,
      idleAfterWork: (agentId) => agentId !== "reviewer",
      workers: { builder: builderEdits, reviewer: () => ({ submit: false }) },
      onObserve: (_handle, context) => {
        if (context.agentId !== "reviewer" || !once(context, "terminate")) return;
        const script = `const { terminateRun } = await import(${JSON.stringify(distUrl("state/store.js"))});
const out = await terminateRun({ runDir: process.argv[1], outcome: "cancelled", reason: "cancelled from another process" });
if (out.outcome !== "recorded") process.exit(1);`;
        const child = spawnSync(
          process.execPath,
          ["--input-type=module", "--eval", script, context.runDir],
          { encoding: "utf8" },
        );
        context.marks.externalStatus = child.status;
      },
    }),

  duplicates: () =>
    scenario({
      verify: false,
      workers: {
        builder: ({ count }) => ({ edit: edit(`v${count}\n`), twice: true }),
        reviewer: () => ({ verdict: "pass" }),
      },
    }),

  "agent-gone": () =>
    scenario({
      verify: false,
      idleAfterWork: () => false,
      workers: { builder: () => ({ submit: false }), reviewer: () => ({ verdict: "pass" }) },
      onObserve: async (handle, context) => {
        if (
          context.agentId === "builder" &&
          context.journal().some((record) => record.type === "request.dispatched") &&
          once(context, "gone")
        ) {
          await context.runtime.stop(handle, { timeoutMs: 1 });
        }
      },
    }),

  "agent-replaced": () =>
    scenario({
      verify: false,
      idleAfterWork: () => false,
      workers: { builder: () => ({ submit: false }), reviewer: () => ({ verdict: "pass" }) },
      onObserve: (handle, context) => {
        if (
          context.agentId === "builder" &&
          context.journal().some((record) => record.type === "request.dispatched") &&
          once(context, "replace")
        ) {
          context.runtime.emit(handle.runtimeName, {
            lifecycle: "working",
            runtimeStatus: "working",
            order: { terminalId: "term-intruder", stateChangeSeq: 9, revision: null },
          });
        }
      },
    }),

  "altered-input": () =>
    scenario({
      verify: false,
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "fail" }) },
      onObserve: (_handle, context) => {
        if (context.agentId !== "builder") return;
        const journal = context.journal();
        const review = journal.find(
          (record) => record.type === "submission.accepted" && record.stageId === "review",
        );
        if (
          review === undefined ||
          !journal.some((record) => record.type === "gate.recorded" && record.gate === "review") ||
          !once(context, "alter")
        )
          return;
        const copy = join(context.runDir, review.artifact.acceptedPath);
        chmodSync(copy, 0o644);
        writeFileSync(copy, "# Tampered review\n");
      },
    }),

  "moved-before-gate": () =>
    scenario({
      verify: false,
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
      // The repository changes after the passing review's revision was computed, just before its gate.
      onAction: (action, context) => {
        if (
          action.type === "record_gate" &&
          action.gate.gate === "review" &&
          action.gate.decision === "pass" &&
          once(context, "move")
        ) {
          writeFileSync(join(context.repo, "stray.txt"), "changed before the gate\n");
        }
      },
    }),

  "run-timeout-check": () =>
    scenario({
      // A check that would run for ten minutes inside a run allowed 1.5 s.
      verify: { command: ["node", "-e", "setInterval(() => {}, 1000)"], timeoutMs: 600_000 },
      limits: { runTimeoutMs: 1500 },
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
    }),

  "tamper-passing-review": () =>
    scenario({
      verify: false,
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
      // The accepted passing review is altered before its gate is computed.
      onAction: (action, context) => {
        if (action.type !== "compute_revision" || action.gate !== "review") return;
        if (!once(context, "tamper")) return;
        const review = context
          .journal()
          .find((record) => record.type === "submission.accepted" && record.stageId === "review");
        const copy = join(context.runDir, review.artifact.acceptedPath);
        chmodSync(copy, 0o644);
        writeFileSync(copy, "# Tampered passing review\n");
      },
    }),

  "moving-repo": () =>
    scenario({
      verify: false,
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
      // The repository changes before every review gate, so no review tree ever holds still.
      onAction: (action, context) => {
        if (action.type !== "record_gate" || action.gate.gate !== "review") return;
        context.marks.moves = (context.marks.moves ?? 0) + 1;
        writeFileSync(join(context.repo, "stray.txt"), `move ${context.marks.moves}\n`);
      },
    }),

  "moving-reject-fails": () =>
    scenario({
      definitionPath: join(root, "test", "fixtures", "workflows", "reject-fails.mjs"),
      makeInput: (repo) => ({ repo }),
      workers: {
        writer: ({ count }) => ({ edit: edit(`draft ${count}\n`) }),
        critic: () => ({ verdict: "bad" }),
      },
      // The repository changes before every judge gate.
      onAction: (action, context) => {
        if (action.type !== "record_gate" || action.gate.gate !== "judge") return;
        context.marks.moves = (context.marks.moves ?? 0) + 1;
        writeFileSync(join(context.repo, "stray.txt"), `move ${context.marks.moves}\n`);
      },
      after: (context) => {
        context.marks.nextCalls = globalThis.woofReviewNextCalls;
      },
    }),

  "expired-before-dispatch": () =>
    scenario({
      verify: false,
      limits: { runTimeoutMs: 300 },
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
      // The run budget runs out between the dispatch decision and its effect.
      onAction: (action, context) => {
        if (action.type !== "dispatch" || !once(context, "delay")) return;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 450);
      },
    }),

  "lock-held-past-deadline": () =>
    scenario({
      verify: false,
      limits: { runTimeoutMs: 1500 },
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
      // Another process holds journal.lock from just before the first openAttempt until
      // 400 ms past the run deadline.
      onAction: (action, context) => {
        if (action.type !== "dispatch" || !once(context, "held")) return;
        const marker = join(tmp, "lock-held");
        const opened = Date.parse(context.journal()[0].ts);
        const script = `const { withJournalLock } = await import(${JSON.stringify(distUrl("journal/lock.js"))});
const { writeFileSync } = await import("node:fs");
const [runDir, marker, releaseAt] = process.argv.slice(1);
await withJournalLock(runDir, async () => {
  writeFileSync(marker, "held\\n");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(releaseAt) - Date.now())));
});`;
        spawn(
          process.execPath,
          ["--input-type=module", "--eval", script, context.runDir, marker, String(opened + 1900)],
          { stdio: "ignore" },
        );
        const waitUntil = Date.now() + 5000;
        while (!existsSync(marker) && Date.now() < waitUntil) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        context.marks.lockHeldAt = Date.now() - opened;
      },
    }),

  "repository-once": () => {
    let calls = 0;
    return scenario({
      verify: false,
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
      // repository(input) answers admission once, then throws; the driver must not ask again.
      wrapDefinition: (definition) => ({
        ...definition,
        repository: (input) => {
          calls += 1;
          if (calls > 1) throw new Error("repository() called again after admission");
          return definition.repository(input);
        },
      }),
      after: (context) => {
        context.marks.repositoryCalls = calls;
      },
    });
  },

  "fast-worker": () =>
    scenario({
      verify: false,
      submitInDeliver: () => true,
      workers: { builder: builderEdits, reviewer: () => ({ verdict: "pass" }) },
    }),

  "builder-failed": () =>
    scenario({
      verify: false,
      workers: {
        builder: () => ({ status: "failed", note: "Could not build." }),
        reviewer: () => ({ verdict: "pass" }),
      },
    }),

  reuse: () =>
    scenario({
      definitionPath: join(root, "test", "fixtures", "workflows", "two-stage.mjs"),
      makeInput: (repo) => ({ repo }),
      workers: {
        writer: ({ count }) => ({ edit: edit(`draft ${count}\n`) }),
        critic: ({ count }) => ({ verdict: count === 1 ? "rework" : "approve" }),
      },
    }),
};

const run = SCENARIOS[name];
if (run === undefined) {
  console.error(`unknown scenario ${name}`);
  process.exit(2);
}
console.log(JSON.stringify(await run()));
