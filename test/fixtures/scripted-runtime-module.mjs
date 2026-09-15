// Runtime module for `woof run build-review --runtime-module` CLI tests: a
// scripted runtime whose workers submit through the real submission path.
// WOOF_TEST_SCRIPT selects the behaviour ("happy", "always-fail", "hang", "slow");
// WOOF_TEST_RUNTIME_LOG, when set, records every createRuntime call.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const load = (rel) => import(pathToFileURL(join(root, "dist", rel)).href);
const { createScriptedRuntime } = await load("testing.js");
const { submitResult } = await load("submission/submit.js");
const { readSnapshot } = await load("state/snapshot.js");
const { herdrRuntimeName } = await load("runtime/names.js");

const ARTIFACTS = { build: "completion.md", repair: "completion.md", review: "review.md" };

export default function createRuntime({ runDir, runId, plan, repo }) {
  const log = process.env["WOOF_TEST_RUNTIME_LOG"];
  if (log !== undefined) {
    appendFileSync(log, `${JSON.stringify({ runDir, runId, repo, agents: plan.agents })}\n`);
  }
  const mode = process.env["WOOF_TEST_SCRIPT"] ?? "happy";
  const names = {
    builder: herdrRuntimeName(runId, "builder"),
    reviewer: herdrRuntimeName(runId, "reviewer"),
  };
  const agentOf = { [names.builder]: "builder", [names.reviewer]: "reviewer" };
  const hang = mode === "hang";
  const script = {
    timeline: [{ status: "idle", stateChangeSeq: 1 }],
    afterDeliver: hang
      ? [{ status: "working", stateChangeSeq: 2 }]
      : [
          { status: "working", stateChangeSeq: 2 },
          { status: "idle", stateChangeSeq: 3 },
        ],
  };
  const runtime = createScriptedRuntime({
    agents: { [names.builder]: script, [names.reviewer]: script },
  });
  const counts = { builder: 0, reviewer: 0 };
  const pending = new Set();

  async function work(agentId) {
    const snapshot = readSnapshot(runDir);
    const active = snapshot.ok
      ? snapshot.snapshot.agents.find((agent) => agent.agentId === agentId)?.activeAttempt
      : null;
    if (active == null || hang) return;
    counts[agentId] += 1;
    if (agentId === "builder") {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "change.txt"), `version ${counts.builder}\n`);
    }
    const verdict =
      agentId === "builder"
        ? null
        : mode === "always-fail" || counts.reviewer === 1
          ? "fail"
          : "pass";
    const rel = `artifacts/${active.stageId}/visit-${active.visit}/attempt-${active.attempt}/${ARTIFACTS[active.stageId]}`;
    const content = `# ${active.stageId} ${active.visit}.${active.attempt}\n\n${verdict === "fail" ? "Blocking finding." : "Done."}\n`;
    writeFileSync(join(runDir, rel), content);
    await submitResult({
      runDir,
      envelopeRaw: JSON.stringify({
        schemaVersion: 1,
        runId,
        agentId,
        stageId: active.stageId,
        visit: active.visit,
        attempt: active.attempt,
        status: "completed",
        verdict,
        artifact: { path: rel, sha256: createHash("sha256").update(content).digest("hex") },
      }),
    });
  }

  return {
    adapter: "scripted",
    openPane: (input) => runtime.openPane(input),
    startAgent: (input) => runtime.startAgent(input),
    waitFor: (handle, states, timeoutMs) => runtime.waitFor(handle, states, timeoutMs),
    stop: (handle, input) => runtime.stop(handle, input),
    async deliver(handle, text, input) {
      const result = await runtime.deliver(handle, text, input);
      if (runtime.calls().at(-1)?.args.sent === true) pending.add(handle.runtimeName);
      return result;
    },
    async observe(handle, options) {
      // "slow" (p4): the first worker submission waits until WOOF_TEST_RELEASE exists.
      const held =
        mode === "slow" &&
        counts.builder + counts.reviewer === 0 &&
        !existsSync(process.env["WOOF_TEST_RELEASE"] ?? "");
      if (pending.has(handle.runtimeName) && !held) {
        pending.delete(handle.runtimeName);
        await work(agentOf[handle.runtimeName]);
        if (!hang) runtime.advance(handle.runtimeName);
      }
      return runtime.observe(handle, options);
    },
  };
}
