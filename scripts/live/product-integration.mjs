#!/usr/bin/env node
// Live evidence for p4 product integration (plan §6b/§6c). Run inside a Herdr
// pane after `bun run build`, while a run started by `/woof:run` is going:
//
//   node scripts/live/product-integration.mjs --run-dir <dir> --host-pane <pane-id> [--samples <file>]
//
// Every 5 s until the run terminates (and then until its host has released the
// claim, at most 30 s) it samples `woof status <run-dir>` and `herdr pane get`
// for the host pane and each agent pane, then prints PASS/FAIL for the gates it
// can decide from files and pane metadata (L1–L5, L8) and MANUAL for the gates
// that need human inspection or a separate run (L6, L7, L9). It reads only run
// files and `herdr pane get`; it never reads pane text and never sends keys.
// --samples appends each sample as one JSON line to <file>.
// Exit 0 when every decided gate passes, 1 otherwise, 2 on usage.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { settledResultAgreement } from "./lib/observer.mjs";

const woofRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cliPath = join(woofRoot, "dist", "cli.js");
if (!existsSync(cliPath)) {
  console.error("dist/cli.js is missing; run bun run build first");
  process.exit(1);
}
const { createHerdrCliRuntime, deriveRunResult, readJournal, readSnapshot } = await import(
  pathToFileURL(join(woofRoot, "dist", "index.js")).href
);

const { values } = parseArgs({
  options: {
    "run-dir": { type: "string" },
    "host-pane": { type: "string" },
    samples: { type: "string" },
  },
  strict: true,
});
if (values["run-dir"] === undefined || values["host-pane"] === undefined) {
  console.error(
    "Usage: node scripts/live/product-integration.mjs --run-dir <dir> --host-pane <pane-id> [--samples <file>]",
  );
  process.exit(2);
}
// `woof status` reports the canonical run directory; results embed it.
const runDir = realpathSync(resolve(values["run-dir"]));
const hostPane = values["host-pane"];
const SAMPLE_MS = 5000;
const RELEASE_WAIT_MS = 30_000;
const TERMINAL = new Set(["completed", "failed", "cancelled", "exhausted"]);
const herdr = createHerdrCliRuntime({ bin: "herdr" });

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function woofStatus() {
  const result = spawnSync(process.execPath, [cliPath, "status", runDir], { encoding: "utf8" });
  try {
    return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "null");
  } catch {
    return null;
  }
}

/** Pane metadata tokens as a plain object ({} when none; { error } when the pane cannot be read). */
async function tokensOf(paneId) {
  const got = await herdr.inspect(["pane", "get", paneId]);
  if (!got.ok) return { error: got.error.code };
  const tokens = got.result?.pane?.tokens ?? {};
  return Array.isArray(tokens)
    ? Object.fromEntries(tokens.map((token) => [token.key ?? token.name, token.value]))
    : tokens;
}

async function takeSample() {
  const shown = woofStatus();
  const row = {
    at: new Date().toISOString(),
    status: shown?.status?.status ?? null,
    owner: shown?.status?.liveness?.owner ?? null,
    host: await tokensOf(hostPane),
    agents: {},
  };
  const read = readSnapshot(runDir);
  if (read.ok) {
    for (const agent of read.snapshot.agents) {
      if (agent.assignment === null) continue;
      // Herdr reads are cheap and ordered; one pane at a time.
      // oxlint-disable-next-line no-await-in-loop
      const tokens = await tokensOf(agent.assignment.paneId);
      row.agents[agent.agentId] = { paneId: agent.assignment.paneId, tokens };
    }
  }
  console.log(`[sample] ${JSON.stringify(row)}`);
  if (values.samples !== undefined) appendFileSync(values.samples, `${JSON.stringify(row)}\n`);
  return row;
}

const samples = [];
for (;;) {
  // Sampling is sequential by design.
  // oxlint-disable-next-line no-await-in-loop
  const row = await takeSample();
  samples.push(row);
  if (row.status !== null && TERMINAL.has(row.status)) break;
  // oxlint-disable-next-line no-await-in-loop
  await delay(SAMPLE_MS);
}
const releaseDeadline = Date.now() + RELEASE_WAIT_MS;
while (samples.at(-1)?.owner !== "exited" && Date.now() < releaseDeadline) {
  // oxlint-disable-next-line no-await-in-loop
  await delay(SAMPLE_MS);
  // oxlint-disable-next-line no-await-in-loop
  samples.push(await takeSample());
}

const gates = [];
function gate(id, title, pass, evidence) {
  gates.push({ id, pass });
  const verdict = pass === null ? "MANUAL" : pass ? "PASS" : "FAIL";
  console.log(`GATE ${id} ${verdict}: ${title}${evidence === undefined ? "" : ` — ${evidence}`}`);
}

const journal = readJournal(runDir);
const records = journal.ok ? journal.records : [];
const read = readSnapshot(runDir);
const snapshot = read.ok ? read.snapshot : null;
const config = readJson(join(runDir, "config.json"));
const host = readJson(join(runDir, "host.json"));
const hostExit = readJson(join(runDir, "host-exit.json"));
const launch = readJson(join(runDir, "launch.json"));
const outcomeFile = readJson(join(runDir, "outcome.json"));
const final = woofStatus();

const projectRoot = config?.roots?.project?.root ?? null;
const builderRole = config?.agents?.builder;
gate(
  "L1",
  "run.opened records config.json; the builder role comes from the project",
  records[0]?.config !== undefined &&
    builderRole?.source === "project" &&
    projectRoot !== null &&
    builderRole?.path === join(projectRoot, ".woof", "roles", "builder.json"),
  `config ${JSON.stringify(records[0]?.config ?? null)}, builder ${JSON.stringify({ source: builderRole?.source, path: builderRole?.path })}`,
);

const callerPane = launch?.launcher?.paneId ?? null;
const agentPanes = (snapshot?.agents ?? [])
  .map((agent) => agent.assignment?.paneId)
  .filter((paneId) => paneId !== undefined);
gate(
  "L2",
  "host pane differs from the caller pane; agent panes differ from both and each other",
  host?.paneId === hostPane &&
    callerPane !== null &&
    hostPane !== callerPane &&
    agentPanes.length > 0 &&
    new Set([hostPane, callerPane, ...agentPanes]).size === agentPanes.length + 2,
  `host ${host?.paneId}, caller ${callerPane}, agents ${JSON.stringify(agentPanes)}`,
);

gate(
  "L3",
  "the run terminated completed",
  snapshot?.outcome?.outcome === "completed",
  JSON.stringify(snapshot?.outcome ?? null),
);

const derived =
  snapshot?.outcome === null || snapshot === null
    ? null
    : deriveRunResult(snapshot, { runDir, repository: config?.repository ?? null });
// The first reads already happened above; L4 re-reads all three on a mismatch (LV-005).
let firstRead = true;
const agreement = await settledResultAgreement(() => {
  if (firstRead) {
    firstRead = false;
    return { status: final?.result, outcome: outcomeFile?.result, derived };
  }
  const again = readSnapshot(runDir);
  return {
    status: woofStatus()?.result,
    outcome: readJson(join(runDir, "outcome.json"))?.result,
    derived:
      again.ok && again.snapshot.outcome !== null
        ? deriveRunResult(again.snapshot, { runDir, repository: config?.repository ?? null })
        : null,
  };
});
for (const mismatch of agreement.mismatches)
  console.log(`[L4] read ${mismatch.attempt} differed: ${JSON.stringify(mismatch.differs)}`);
gate(
  "L4",
  "woof status result equals deriveRunResult and outcome.json",
  agreement.pass,
  `status result ${final?.result?.outcome}, outcome.json ${outcomeFile?.result?.outcome}, agreed after ${agreement.attempts} read(s)`,
);

const running = samples.filter((row) => row.status !== null && !TERMINAL.has(row.status));
gate(
  "L5",
  "owner alive in every non-terminal sample and exited after",
  running.length > 0 &&
    running.every((row) => row.owner === "alive") &&
    samples.at(-1)?.owner === "exited" &&
    hostExit !== null,
  `${running.length} non-terminal samples, owners ${JSON.stringify([...new Set(running.map((row) => row.owner))])}, final ${samples.at(-1)?.owner}, host-exit.json ${JSON.stringify(hostExit)}`,
);

gate(
  "L6",
  "the caller's final message names the outcome, runId and accepted review path (the verifier reads the caller agent's recent output by hand)",
  null,
  `expect outcome ${snapshot?.outcome?.outcome}, runId ${snapshot?.runId}, review ${derived?.artifacts?.review?.acceptedPath ?? null}`,
);
gate("L7", "runtime-loss probe on a second run (verifier procedure §6b step 7)", null);

const hostToken = (row) => (typeof row.host?.woof === "string" ? row.host.woof : "");
const outcome = snapshot?.outcome?.outcome;
const lastHostToken = hostToken(samples.at(-1) ?? {});
const roles = new Map();
for (const row of samples)
  for (const [agentId, value] of Object.entries(row.agents))
    if (typeof value.tokens?.["woof-role"] === "string")
      roles.set(agentId, value.tokens["woof-role"]);
gate(
  "L8",
  "host pane token shows running while running and the outcome after; agent panes carry woof-role",
  samples.some((row) => row.status === "running" && hostToken(row).startsWith("running")) &&
    outcome !== undefined &&
    (lastHostToken === outcome || lastHostToken.startsWith(`${outcome} `)) &&
    agentPanes.length > 0 &&
    roles.size === agentPanes.length,
  `final host token ${JSON.stringify(lastHostToken)}, roles ${JSON.stringify(Object.fromEntries(roles))}`,
);
gate("L9", "Herdr actions status and cancel (verifier procedure §6c)", null);

const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
const forbidden = [
  ["agent", "read"],
  ["pane", "read"],
  ["send", "keys"],
].map((parts) => parts.join(parts[0] === "send" ? "-" : " "));
const hits = forbidden.filter((needle) => source.includes(needle));
console.log(
  `script source grep for forbidden pane commands: ${hits.length === 0 ? "no matches" : hits.join(", ")}`,
);

const decided = gates.filter((item) => item.pass !== null);
const failed = decided.filter((item) => !item.pass);
console.log(
  `${decided.length - failed.length}/${decided.length} decided gates passed${failed.length > 0 ? `; failed: ${failed.map((item) => item.id).join(", ")}` : ""}; manual: ${gates
    .filter((item) => item.pass === null)
    .map((item) => item.id)
    .join(", ")}`,
);
process.exit(failed.length === 0 && hits.length === 0 ? 0 : 1);
