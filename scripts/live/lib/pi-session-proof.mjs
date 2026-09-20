import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Authorship proof for a pi agent's own session file (p8a, review P8A-R6).
 *
 * Gate 6 of the live script proves that Woof delivered the build and repair
 * requests to the session it assigned. That is delivery, not authorship: a
 * different process with access to the shared repository and run directory
 * could still have produced the artifacts while the pi session did something
 * harmless. This module is what ties the accepted work to that session, so it
 * is deliberately strict and refuses anything it cannot positively match.
 *
 * For each phase (build, repair) it requires, with a **successful** tool result:
 *   - an `edit`/`write` to the repository's `src/slugify.mjs`;
 *   - in build only, a `write` to the repository's `test/slugify.test.mjs`;
 *   - a `write` of an envelope file under the current run directory;
 *   - a `bash` call that is exactly the run's own CLI invoked as
 *     `<cliPath> submit --run-dir <runDir> --envelope <that phase's envelope>`.
 * The submit is then paired with the journal's `submission.accepted` for the
 * same stage: by receipt id when pi's tool result carries one, and only when no
 * receipt is present at all by the submit call preceding that record's timestamp.
 * A receipt that is present and does not match fails outright. The pairing used
 * is reported, never silently downgraded.
 *
 * The model is the one active at each qualifying call, tracked through
 * `model_change` entries in order, so work done under one model cannot be
 * excused by a later switch to the expected one.
 *
 * It parses only pi's session file and the journal facts passed in; it never
 * reads the repository to decide whether work happened.
 */

/** At most this many extracted call lines per phase, each truncated, so a log stays bounded. */
export const PROOF_LINES_PER_PHASE = 12;
export const PROOF_LINE_CHARS = 160;

const PHASES = ["build", "repair"];

/** Splits a shell command into tokens, honouring single and double quotes. */
export function tokenize(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current !== "") tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
  }
  if (started || current !== "") tokens.push(current);
  return tokens;
}

/** The value following `flag`, or null when the flag is absent or last. */
function flagValue(tokens, flag) {
  const index = tokens.indexOf(flag);
  if (index < 0 || index + 1 >= tokens.length) return null;
  return tokens[index + 1];
}

/** A receipt id printed by `woof submit`, from the tool result text. */
export function receiptIdOf(text) {
  const match = /"receiptId"\s*:\s*"([^"]+)"/.exec(text);
  return match === null ? null : match[1];
}

/** Shell metacharacters that would make a command more than one plain invocation. */
const SHELL_OPERATORS = /[;&|<>`$(){}]|\n/;

/**
 * Whether the command is exactly `<node executable> <cliPath> submit …` and nothing else:
 * no prefix command (`echo …`, `env …`, `sh -c …`), no pipeline, no chaining, no
 * substitution. Anything that merely mentions the CLI path is not pi running the CLI.
 */
export function isDirectCliInvocation(command, cliPath) {
  if (SHELL_OPERATORS.test(command)) return false;
  const tokens = tokenize(command);
  if (tokens.length < 3) return false;
  const executable = tokens[0];
  const base = executable.slice(executable.lastIndexOf("/") + 1);
  if (base !== "node" && base !== "node.exe") return false;
  return tokens[1] === cliPath && tokens[2] === "submit";
}

function emptyPhase() {
  return {
    calls: [],
    repoEdit: false,
    testWrite: false,
    envelopePaths: [],
    submit: null,
    pairing: "none",
    receiptId: null,
    models: new Set(),
  };
}

/** An empty per-phase view, so callers and the log never have to guard on shape. */
function emptyView() {
  return { calls: [], pairing: "none", receiptId: null, models: [] };
}

function fail(reason) {
  return { ok: false, reason, phases: { build: emptyView(), repair: emptyView() } };
}

/**
 * @param options.sessionPath  pi's session file (the builder assignment's sessionId).
 * @param options.repairDispatchTs  ISO timestamp of the repair dispatch; splits the phases.
 * @param options.runDir  the run directory this run used.
 * @param options.repoDir  the fixture repository.
 * @param options.cliPath  the `dist/cli.js` path this run invoked.
 * @param options.expectedModel  `provider/id` the run configured.
 * @param options.accepted  journal `submission.accepted` records: {stageId, receiptId, ts}.
 * @param options.readFile  injectable reader, for tests.
 */
export function readPiSessionProof(options) {
  const {
    sessionPath,
    repairDispatchTs,
    runDir,
    repoDir,
    cliPath,
    expectedModel,
    accepted = [],
    readFile = (path) => readFileSync(path, "utf8"),
  } = options;

  if (typeof sessionPath !== "string" || !sessionPath.endsWith(".jsonl"))
    return fail(`builder sessionId is not a pi session file: ${String(sessionPath)}`);
  if (typeof repairDispatchTs !== "string")
    return fail("no repair dispatch, so the phases cannot be split");
  const repairAt = Date.parse(repairDispatchTs);
  if (Number.isNaN(repairAt))
    return fail(`unparseable repair dispatch timestamp: ${repairDispatchTs}`);

  let text;
  try {
    text = readFile(sessionPath);
  } catch (error) {
    return fail(`session file unreadable: ${error.message}`);
  }

  // Pass 1: tool results, by call id, so a call can be required to have succeeded.
  const results = new Map();
  const entries = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    entries.push(entry);
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "toolResult") continue;
    const body = Array.isArray(message.content)
      ? message.content.map((part) => part?.text ?? "").join("")
      : "";
    results.set(message.toolCallId, { isError: message.isError === true, text: body });
  }

  // Pass 2: qualifying tool calls, in order, with the model active at each one.
  const sessionCwd =
    entries.find((entry) => entry.type === "session")?.cwd ?? repoDir ?? process.cwd();
  const absolute = (path) => (isAbsolute(path) ? path : resolve(sessionCwd, path));
  const wantSlugify = resolve(repoDir, "src/slugify.mjs");
  const wantTest = resolve(repoDir, "test/slugify.test.mjs");
  const phases = { build: emptyPhase(), repair: emptyPhase() };
  let activeModel = null;

  for (const entry of entries) {
    if (entry.type === "model_change") {
      const provider = entry.provider ?? null;
      const model = entry.modelId ?? null;
      activeModel = provider === null || model === null ? null : `${provider}/${model}`;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const at = Date.parse(entry.timestamp ?? "");
    const phaseName = Number.isNaN(at) || at >= repairAt ? "repair" : "build";
    const phase = phases[phaseName];
    for (const part of message.content) {
      if (part?.type !== "toolCall") continue;
      const result = results.get(part.id);
      // No result, or a failed one, is not evidence of anything.
      if (result === undefined || result.isError) continue;
      const name = String(part.name ?? "");
      const args =
        typeof part.arguments === "object" && part.arguments !== null ? part.arguments : {};
      const path = typeof args.path === "string" ? args.path : "";
      const command = typeof args.command === "string" ? args.command : "";

      if ((name === "edit" || name === "write") && path !== "") {
        const full = absolute(path);
        if (full === wantSlugify) {
          phase.repoEdit = true;
          phase.models.add(activeModel);
          phase.calls.push(`${name}: ${path}`);
        } else if (full === wantTest) {
          phase.testWrite = true;
          phase.models.add(activeModel);
          phase.calls.push(`${name}: ${path}`);
        } else if (name === "write" && full.startsWith(`${runDir}/`) && full.endsWith(".json")) {
          phase.envelopePaths.push(full);
          phase.models.add(activeModel);
          phase.calls.push(`${name}: ${full}`);
        }
        continue;
      }

      if (name !== "bash" || command === "") continue;
      if (!isDirectCliInvocation(command, cliPath)) continue;
      const tokens = tokenize(command);
      if (flagValue(tokens, "--run-dir") !== runDir) continue;
      const envelope = flagValue(tokens, "--envelope");
      if (envelope === null || !phase.envelopePaths.includes(absolute(envelope))) continue;
      phase.submit = { command, envelope: absolute(envelope), at };
      phase.receiptId = receiptIdOf(result.text);
      phase.models.add(activeModel);
      phase.calls.push(`bash: ${command}`);
    }
  }

  // Pair each phase's submit with the journal record for the same stage.
  for (const name of PHASES) {
    const phase = phases[name];
    if (phase.submit === null) continue;
    const record = accepted.find((item) => item.stageId === name);
    if (record === undefined) continue;
    if (phase.receiptId !== null) {
      // A receipt that is present and does not match is a contradiction, not a reason
      // to fall back: the submit printed a different receipt from the accepted one.
      if (phase.receiptId === record.receiptId) phase.pairing = "receipt";
      continue;
    }
    const recordAt = Date.parse(record.ts ?? "");
    if (!Number.isNaN(recordAt) && !Number.isNaN(phase.submit.at) && phase.submit.at <= recordAt)
      phase.pairing = "timestamp";
  }

  const problems = [];
  for (const name of PHASES) {
    const phase = phases[name];
    if (!phase.repoEdit) problems.push(`${name}: no successful edit or write of src/slugify.mjs`);
    if (name === "build" && !phase.testWrite)
      problems.push("build: no successful write of test/slugify.test.mjs");
    if (phase.envelopePaths.length === 0)
      problems.push(`${name}: no successful envelope write under the run directory`);
    if (phase.submit === null)
      problems.push(
        `${name}: no successful ${"`"}<cli> submit --run-dir <runDir> --envelope <envelope>${"`"} call`,
      );
    else if (phase.pairing === "none")
      problems.push(`${name}: the submit call pairs with no accepted submission for that stage`);
    const models = [...phase.models];
    if (models.length !== 1 || models[0] !== expectedModel)
      problems.push(
        `${name}: qualifying calls ran under ${models.map((model) => String(model)).join(", ") || "no model"}, not ${expectedModel}`,
      );
  }

  const view = {};
  for (const name of PHASES) {
    view[name] = {
      calls: phases[name].calls
        .slice(0, PROOF_LINES_PER_PHASE)
        .map((line) => line.slice(0, PROOF_LINE_CHARS)),
      pairing: phases[name].pairing,
      receiptId: phases[name].receiptId,
      models: [...phases[name].models],
    };
  }
  if (problems.length > 0) return { ok: false, reason: problems.join("; "), phases: view };
  return { ok: true, model: expectedModel, phases: view };
}
