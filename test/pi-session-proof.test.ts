import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readPiSessionProof,
  receiptIdOf,
  tokenize,
} from "../scripts/live/lib/pi-session-proof.mjs";
import { repoRoot } from "./helpers/process.js";

/**
 * Review P8A-R6: gate 6 of the live script proves Woof delivered both requests
 * to the assigned pi session; only this proof ties the accepted build and repair
 * to that session. The transcripts below are the concrete false positives the
 * review described, each of which the earlier permissive version accepted.
 *
 * The passing case is the real recorded session from live run
 * `live-pi-br-20260920-064617`, trimmed to its qualifying entries and with the
 * repository, run directory and CLI paths parameterized so it runs anywhere.
 */

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TEMPLATE = readFileSync(
  join(repoRoot, "test", "fixtures", "pi-session-build-repair.jsonl"),
  "utf8",
);

/** The phases split here: after the build submit, before the repair edit. */
const REPAIR_DISPATCH_TS = "2026-09-20T06:47:40.000Z";
const MODEL = "openai-codex/gpt-5.6-sol";
const BUILD_RECEIPT = "rcpt-5-e07c875d9b31";
const REPAIR_RECEIPT = "rcpt-15-2534d418d7c3";

interface Fixture {
  sessionPath: string;
  runDir: string;
  repoDir: string;
  cliPath: string;
}

/** Renders the recorded transcript into a temporary tree, optionally mutating each entry. */
function fixture(mutate: (entry: Json) => Json | null = (entry) => entry): Fixture {
  const root = mkdtempSync(join(tmpdir(), "woof-pi-proof-"));
  dirs.push(root);
  const repoDir = join(root, "fixture-repo");
  const runDir = join(root, "run");
  const cliPath = join(root, "dist", "cli.js");
  const rendered = TEMPLATE.replaceAll("{{REPO}}", repoDir)
    .replaceAll("{{RUNDIR}}", runDir)
    .replaceAll("{{CLI}}", cliPath);
  const entries = rendered
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Json)
    .map((entry) => mutate(entry))
    .filter((entry): entry is Json => entry !== null);
  const sessionPath = join(root, "session.jsonl");
  writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { sessionPath, runDir, repoDir, cliPath };
}

const accepted = [
  { stageId: "build", receiptId: BUILD_RECEIPT, ts: "2026-09-20T06:47:10.566Z" },
  { stageId: "repair", receiptId: REPAIR_RECEIPT, ts: "2026-09-20T06:48:14.279Z" },
];

function proof(f: Fixture, overrides: Record<string, unknown> = {}) {
  return readPiSessionProof({
    sessionPath: f.sessionPath,
    repairDispatchTs: REPAIR_DISPATCH_TS,
    runDir: f.runDir,
    repoDir: f.repoDir,
    cliPath: f.cliPath,
    expectedModel: MODEL,
    accepted,
    ...overrides,
  });
}

/** Every assistant tool call in an entry, for mutation helpers. */
function toolCalls(entry: Json): Json[] {
  if (entry["type"] !== "message" || entry["message"]?.["role"] !== "assistant") return [];
  const content = entry["message"]["content"];
  return Array.isArray(content)
    ? content.filter((part: Json) => part?.["type"] === "toolCall")
    : [];
}

describe("the recorded pi session", () => {
  it("passes, and pairs both submits to the journal by receipt id", () => {
    const result = proof(fixture());
    expect(result.ok, result.reason).toBe(true);
    expect(result.phases.build.pairing).toBe("receipt");
    expect(result.phases.repair.pairing).toBe("receipt");
    expect(result.phases.build.receiptId).toBe(BUILD_RECEIPT);
    expect(result.phases.repair.receiptId).toBe(REPAIR_RECEIPT);
    expect(result.phases.build.models).toEqual([MODEL]);
  });

  it("falls back to timestamp pairing and says so when the result carries no receipt", () => {
    // The pairing that was used is evidence in its own right, so it is reported.
    const result = proof(
      fixture((entry) => {
        if (entry["type"] === "message" && entry["message"]?.["role"] === "toolResult")
          entry["message"]["content"] = [{ type: "text", text: "ok" }];
        return entry;
      }),
    );
    expect(result.ok, result.reason).toBe(true);
    expect(result.phases.build.pairing).toBe("timestamp");
    expect(result.phases.repair.pairing).toBe("timestamp");
    expect(result.phases.build.receiptId).toBeNull();
  });
});

describe("transcripts that must not prove authorship", () => {
  it("rejects a session that only wrote /tmp/marker", () => {
    // The concrete false positive: pi writes something harmless while another
    // process makes the real change and submits.
    const result = proof(
      fixture((entry) => {
        for (const call of toolCalls(entry)) {
          const path = call["arguments"]?.["path"];
          if (typeof path === "string" && !path.endsWith(".json"))
            call["arguments"]["path"] = "/tmp/marker";
        }
        return entry;
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("src/slugify.mjs");
  });

  it("rejects `echo submit --run-dir`, which is not the run's CLI", () => {
    const result = proof(
      fixture((entry) => {
        for (const call of toolCalls(entry)) {
          const command = call["arguments"]?.["command"];
          if (typeof command === "string" && command.includes(" submit "))
            call["arguments"]["command"] = command.replace(/^\S+ \S+/, "echo");
        }
        return entry;
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("submit");
  });

  it("rejects calls whose tool result failed", () => {
    const result = proof(
      fixture((entry) => {
        if (entry["type"] === "message" && entry["message"]?.["role"] === "toolResult")
          entry["message"]["isError"] = true;
        return entry;
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("src/slugify.mjs");
  });

  it("rejects a submit that names a different run directory", () => {
    const result = proof(
      fixture((entry) => {
        for (const call of toolCalls(entry)) {
          const command = call["arguments"]?.["command"];
          if (typeof command === "string" && command.includes("--run-dir"))
            call["arguments"]["command"] = command.replace(/--run-dir \S+/, "--run-dir /tmp/other");
        }
        return entry;
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("submit");
  });

  it("rejects work done under one model with a switch to the expected one afterwards", () => {
    // The old check read the last model_change anywhere in the session.
    const switched = fixture((entry) => {
      if (entry["type"] === "model_change") {
        entry["provider"] = "github-copilot";
        entry["modelId"] = "kimi-k3";
      }
      return entry;
    });
    const lines = readFileSync(switched.sessionPath, "utf8").trimEnd().split("\n");
    lines.push(
      JSON.stringify({
        type: "model_change",
        timestamp: "2026-09-20T06:49:00.000Z",
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
      }),
    );
    writeFileSync(switched.sessionPath, `${lines.join("\n")}\n`);
    const result = proof(switched);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not openai-codex/gpt-5.6-sol");
  });

  it("rejects a submit that pairs with no accepted submission for its stage", () => {
    const result = proof(fixture(), { accepted: [] });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("pairs with no accepted submission");
  });

  it("rejects a session with no repair phase at all", () => {
    // Everything happens before the repair dispatch: the repair phase is empty.
    const result = proof(fixture(), { repairDispatchTs: "2026-09-20T23:59:59.000Z" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("repair");
  });

  it("refuses a sessionId that is not a pi session file", () => {
    const result = proof(fixture(), { sessionPath: "0b5d1fec-not-a-pi-session" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not a pi session file");
  });
});

describe("the command parser", () => {
  it("keeps quoted arguments whole", () => {
    expect(tokenize(`node cli.js submit --envelope "/a b/env.json"`)).toEqual([
      "node",
      "cli.js",
      "submit",
      "--envelope",
      "/a b/env.json",
    ]);
  });

  it("reads a receipt id out of submit's output, or reports none", () => {
    expect(receiptIdOf('{"outcome":"accepted","receipt":{"receiptId":"rcpt-5-abc"}}')).toBe(
      "rcpt-5-abc",
    );
    expect(receiptIdOf("ok")).toBeNull();
  });
});
