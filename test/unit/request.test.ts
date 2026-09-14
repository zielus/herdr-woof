import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Json = Record<string, unknown>;
type Render = (
  input: Json,
) => { ok: true; text: string; bytes: number } | { ok: false; reason: string; bytes: number };
type Launch = (
  agent: Json,
) => { ok: true; args: string[] } | { ok: false; reason: string; message: string };

let renderRequest: Render;
let shellQuote: (value: string) => string;
let launchArgs: Launch;

beforeAll(async () => {
  ({ renderRequest, shellQuote } = await loadDist<{
    renderRequest: Render;
    shellQuote: typeof shellQuote;
  }>("scheduler/request.js"));
  ({ launchArgs } = await loadDist<{ launchArgs: Launch }>("scheduler/launch.js"));
});

const TREE = "c".repeat(40);
const SHA = "a".repeat(64);

function input(overrides: Json = {}): Json {
  return {
    runId: "run-7",
    workflow: { name: "build-review", version: "1" },
    agentId: "builder",
    role: "builder",
    stageId: "build",
    visit: 1,
    attempt: 1,
    cause: "initial",
    round: 0,
    repository: "/work/repo",
    revision: { head: null, tree: TREE },
    runDir: "/runs/run-7",
    artifactFile: "completion.md",
    verdicts: [],
    submitCommand: ["/usr/local/bin/node", "/opt/woof/dist/cli.js"],
    goal: "Implement the task.",
    instructions: "Change the repository, then describe what you changed.",
    inputs: [],
    task: {
      title: "Implement slugify",
      description: "Lowercase and hyphenate.",
      acceptanceCriteria: ["lowercase", "no leading hyphens"],
      context: { b: 2, a: [1] },
    },
    ...overrides,
  };
}

function text(overrides: Json = {}): string {
  const result = renderRequest(input(overrides));
  if (!result.ok) throw new Error(`render refused: ${result.reason}`);
  return result.text;
}

describe("renderRequest", () => {
  it("renders a build request exactly", () => {
    expect(text()).toBe(`# Woof work request v1
Run run-7 · workflow build-review@1 · you are agent builder (role builder)
Stage build · visit 1 · attempt 1 · initial · round 0
Repository (your working directory): /work/repo
Repository revision when this request was sent: tree ${TREE} (HEAD none)

## Goal
Implement the task.

## Task
Implement slugify
Lowercase and hyphenate.

### Acceptance criteria
- lowercase
- no leading hyphens

### Context
\`\`\`json
{
  "a": [
    1
  ],
  "b": 2
}
\`\`\`

## Inputs — read these exact files
(none)

## What to do
Change the repository, then describe what you changed.

## Your artifact
Write your artifact to exactly: /runs/run-7/artifacts/build/visit-1/attempt-1/completion.md
It must be a non-empty regular file inside that directory, at most 32 MiB.

## Finish by submitting (required)
1. sha256 of the artifact: \`shasum -a 256 /runs/run-7/artifacts/build/visit-1/attempt-1/completion.md\` (or \`sha256sum\`).
2. Write this envelope to /runs/run-7/artifacts/build/visit-1/attempt-1/envelope.json, filling sha256 and the verdict:
   {"schemaVersion":1,"runId":"run-7","agentId":"builder","stageId":"build","visit":1,"attempt":1,"status":"completed","verdict":<null>,"artifact":{"path":"artifacts/build/visit-1/attempt-1/completion.md","sha256":"<fill>"}}
   Use status "failed" only if you could not do the work; still write an artifact saying why.
3. Run: /usr/local/bin/node /opt/woof/dist/cli.js submit --run-dir /runs/run-7 --envelope /runs/run-7/artifacts/build/visit-1/attempt-1/envelope.json
4. Exit 0 prints "accepted" or "duplicate": you are done; end your turn.
   Exit 2 prints a rejection with reason and details: fix the envelope or artifact and run the same command again.
   Exit 3 is an infrastructure problem: say so and end your turn.
Do not edit files under /runs/run-7 other than /runs/run-7/artifacts/build/visit-1/attempt-1. Do not message other agents.
`);
    // Deterministic for the same input.
    expect(text()).toBe(text());
  });

  it("renders a review request with verdicts, role instructions and a revision with HEAD", () => {
    const review = text({
      agentId: "reviewer",
      role: "reviewer",
      stageId: "review",
      verdicts: ["pass", "fail"],
      artifactFile: "review.md",
      round: 1,
      revision: { head: "b".repeat(40), tree: TREE },
      roleInstructions: "Every module must begin with the nonce line.",
      task: { title: "T", description: "D", acceptanceCriteria: ["c"] },
    });
    expect(review).toContain("Stage review · visit 1 · attempt 1 · initial · round 1");
    expect(review).toContain(`tree ${TREE} (HEAD ${"b".repeat(40)})`);
    expect(review).toContain(
      "## Project instructions for your role\nEvery module must begin with the nonce line.\n",
    );
    expect(review).toContain('"verdict":<one of "pass", "fail">');
    expect(review).not.toContain("### Context");
  });

  it("lists repair inputs with the absolute accepted path, receipt and sha256", () => {
    const repair = text({
      stageId: "repair",
      inputs: [
        {
          label: "review",
          path: "/runs/run-7/accepted/review/visit-1/attempt-1/review.md",
          sha256: SHA,
          accepted: { stageId: "review", visit: 1, attempt: 1, receiptId: "rcpt-9-aaaaaaaaaaaa" },
        },
        {
          label: "verification",
          path: "/runs/run-7/checks/verify/build-v1-a1/output.log",
          sha256: SHA,
          checkId: "verify",
        },
      ],
    });
    expect(repair).toContain(
      `## Inputs — read these exact files\n- review: /runs/run-7/accepted/review/visit-1/attempt-1/review.md (stage review visit 1 attempt 1, receipt rcpt-9-aaaaaaaaaaaa, sha256 ${SHA})\n- verification: /runs/run-7/checks/verify/build-v1-a1/output.log (check verify evidence, sha256 ${SHA})\n`,
    );
  });

  it("renders a format repair with the journaled rejections, or none", () => {
    const repaired = text({
      attempt: 2,
      cause: "format_repair",
      previous: {
        attempt: 1,
        rejections: [
          { reason: "artifact_hash_mismatch", message: "sha256 differs\nfrom the envelope" },
        ],
      },
    });
    expect(repaired).toContain("Stage build · visit 1 · attempt 2 · format repair · round 0");
    expect(repaired).toContain(
      "## Why you are receiving this\nYour previous attempt (build visit 1 attempt 1) ended without an accepted submission.\nJournaled rejections for that attempt:\n- artifact_hash_mismatch: sha256 differs from the envelope\n",
    );
    expect(repaired).toContain(
      "Your previous artifact, if any: /runs/run-7/artifacts/build/visit-1/attempt-1/completion.md",
    );
    expect(repaired).toContain(
      "Write your artifact to exactly: /runs/run-7/artifacts/build/visit-1/attempt-2/completion.md",
    );
    expect(repaired).not.toContain("## Goal");
    expect(repaired).not.toContain("## Task");

    const silent = text({
      attempt: 2,
      cause: "format_repair",
      previous: { attempt: 1, rejections: [] },
    });
    expect(silent).toContain(
      "Journaled rejections for that attempt: none — no submission was recorded.",
    );
    expect(text({ attempt: 3, cause: "work_retry" })).toContain("attempt 3 · work retry · round 0");
  });

  it("refuses a request larger than 32 KiB", () => {
    const result = renderRequest(
      input({
        task: { title: "T", description: "x".repeat(33 * 1024), acceptanceCriteria: ["c"] },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "request_too_large" });
    expect(!result.ok && result.bytes).toBeGreaterThan(32 * 1024);
  });

  it("quotes the submit command for a POSIX shell", () => {
    const quoted = text({
      runDir: "/runs/it's here",
      submitCommand: ["/Applications/Node Runtime/node", "/opt/woof/cli.js"],
    });
    expect(quoted).toContain(
      "3. Run: '/Applications/Node Runtime/node' /opt/woof/cli.js submit --run-dir '/runs/it'\\''s here' --envelope '/runs/it'\\''s here/artifacts/build/visit-1/attempt-1/envelope.json'",
    );
    expect(shellQuote("plain/path-1.js")).toBe("plain/path-1.js");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });
});

describe("launchArgs", () => {
  it("adds the model and the run directory for claude, before the caller's arguments", () => {
    expect(
      launchArgs({
        kind: "claude",
        model: "sonnet",
        args: ["--permission-mode", "auto"],
        runDir: "/runs/r",
      }),
    ).toEqual({
      ok: true,
      args: ["--model", "sonnet", "--add-dir", "/runs/r", "--permission-mode", "auto"],
    });
    expect(launchArgs({ kind: "claude", model: null, args: [], runDir: "/runs/r" })).toEqual({
      ok: true,
      args: ["--add-dir", "/runs/r"],
    });
  });

  it("refuses every other kind", () => {
    for (const kind of ["codex", "Claude", ""]) {
      expect(launchArgs({ kind, model: null, args: [], runDir: "/r" })).toMatchObject({
        ok: false,
        reason: "agent_kind_unsupported",
      });
    }
  });
});
