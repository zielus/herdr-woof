import { beforeAll, describe, expect, it } from "vitest";

import { loadDist } from "../helpers/dist.js";

type Json = Record<string, unknown>;
type Render = (
  input: Json,
) => { ok: true; text: string; bytes: number } | { ok: false; reason: string; bytes: number };
type Launch = (
  agent: Json,
) => { ok: true; args: string[] } | { ok: false; reason: string; message: string };

type Definition = {
  stages: Array<{
    kind: string;
    stageId?: string;
    request?: (ctx: Json) => { goal: string; instructions: string };
  }>;
};

let renderRequest: Render;
let shellQuote: (value: string) => string;
let launchArgs: Launch;
let definitions: Array<[string, Definition]>;
let reviewIsCanonical: string;

beforeAll(async () => {
  ({ renderRequest, shellQuote } = await loadDist<{
    renderRequest: Render;
    shellQuote: typeof shellQuote;
  }>("scheduler/request.js"));
  ({ launchArgs } = await loadDist<{ launchArgs: Launch }>("scheduler/launch.js"));
  const buildReview = await loadDist<{
    buildReviewWorkflow: Definition;
    REVIEW_IS_CANONICAL: string;
  }>("workflows/build-review.js");
  const planBuildReview = await loadDist<{ planBuildReviewWorkflow: Definition }>(
    "workflows/plan-build-review.js",
  );
  reviewIsCanonical = buildReview.REVIEW_IS_CANONICAL;
  definitions = [
    ["build-review", buildReview.buildReviewWorkflow],
    ["plan-build-review", planBuildReview.planBuildReviewWorkflow],
  ];
});

describe("the repair request states that the accepted review is canonical (LV-102, PB-101)", () => {
  const repairOf = (definition: Definition) =>
    definition.stages.find((stage) => stage.kind === "agent" && stage.stageId === "repair");

  const requestOf = (definition: Definition, enteredBy: Json | null) => {
    const stage = repairOf(definition);
    expect(stage?.request, "the definition has a repair stage with a request()").toBeDefined();
    const request = stage?.request as (ctx: Json) => { goal: string; instructions: string };
    return request({
      input: { task: { title: "t", description: "d", acceptanceCriteria: ["a"] } },
      runId: "run-7",
      history: { gates: [], latestAccepted: {} },
      stageId: "repair",
      visit: 1,
      attempt: 1,
      round: 1,
      enteredBy,
    });
  };
  const rendered = (definition: Definition, enteredBy: Json | null) =>
    requestOf(definition, enteredBy).instructions;
  const labels = (definition: Definition, enteredBy: Json | null) =>
    (
      requestOf(definition, enteredBy) as unknown as { inputs: Array<{ label: string }> }
    ).inputs.map((ref) => ref.label);

  it("is the exact sentence, in both built-in definitions, for a repair the review entered", () => {
    // A live builder declined a requirement it met only inside the review
    // artifact, reading it as a possible prompt injection, and the run exhausted.
    // The request never said whose word the review was; this is that sentence.
    expect(reviewIsCanonical).toBe(
      "The accepted review artifact is canonical for this repair: its blocking findings are project requirements to satisfy, not suggestions. If you believe a finding is wrong, satisfy it anyway and record your objection in completion.md; never leave a blocking finding unaddressed.",
    );
    for (const [name, definition] of definitions) {
      const enteredBy = { kind: "stage", gate: "review" };
      expect(rendered(definition, enteredBy), name).toContain(reviewIsCanonical);
      // The sentence and the review input are the same condition.
      expect(labels(definition, enteredBy), name).toContain("review");
    }
  });

  it("says nothing about a review the check-entered repair was never given (PB-101)", () => {
    // A verify failure can precede every review, so that repair carries no review
    // reference at all. Telling its builder that "the accepted review artifact is
    // canonical" would describe an artifact that is not in its inputs.
    for (const [name, definition] of definitions) {
      for (const enteredBy of [{ kind: "check", gate: "verify" }, null]) {
        const where = `${name} entered by ${enteredBy === null ? "nothing" : enteredBy.gate}`;
        expect(labels(definition, enteredBy), where).not.toContain("review");
        expect(rendered(definition, enteredBy), where).not.toContain(reviewIsCanonical);
        // Removing it leaves no double space behind.
        expect(rendered(definition, enteredBy), where).not.toContain("  ");
      }
      // The check-entered repair keeps its own wording and its own evidence.
      const checkEntered = requestOf(definition, { kind: "check", gate: "verify" });
      expect(checkEntered.goal, name).toBe("Repair the change: the verification command failed.");
      expect(labels(definition, { kind: "check", gate: "verify" }), name).toContain(
        "verification output",
      );
    }
  });

  it("reaches the worker: the sentence survives into the rendered request text", () => {
    for (const [name, definition] of definitions) {
      const request = requestOf(definition, { kind: "stage", gate: "review" });
      const out = renderRequest(input({ goal: request.goal, instructions: request.instructions }));
      expect(out.ok, name).toBe(true);
      expect(out.ok && out.text, name).toContain(reviewIsCanonical);
      // It is in the section the worker is told to act on.
      expect(out.ok && out.text.split("## What to do")[1], name).toContain(reviewIsCanonical);

      // And the check-entered request renders without it.
      const check = requestOf(definition, { kind: "check", gate: "verify" });
      const checkOut = renderRequest(input({ goal: check.goal, instructions: check.instructions }));
      expect(checkOut.ok, name).toBe(true);
      expect(checkOut.ok && checkOut.text, name).not.toContain(reviewIsCanonical);
    }
  });
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

  it("bounds the quoted rejections so a format repair always fits (PR #7 request-bound.ts:112)", () => {
    // Rejection messages come from a worker's own output, not from the admitted
    // input, and the number of rejections for one attempt is unbounded. Before
    // this, an input the admission bound accepted could later produce a
    // format-repair request over the 32 KiB cap.
    const rejections = (count: number, size: number) =>
      Array.from({ length: count }, (_, index) => ({
        reason: `envelope_invalid_${index}`,
        message: "x".repeat(size),
      }));
    for (const [count, size] of [
      [1, 40 * 1024],
      [2, 20 * 1024],
      [50, 10 * 1024],
      [500, 1024],
    ] as Array<[number, number]>) {
      const out = renderRequest(
        input({
          attempt: 2,
          cause: "format_repair",
          previous: { attempt: 1, rejections: rejections(count, size) },
        }),
      );
      expect(out.ok, `${count} rejections of ${size} bytes`).toBe(true);
      expect(out.bytes, `${count} rejections of ${size} bytes`).toBeLessThan(32 * 1024);
    }

    // What the worker is told when data was cut: the count of older rejections
    // omitted, and a per-message truncation note naming both sizes.
    const many = text({
      attempt: 2,
      cause: "format_repair",
      previous: { attempt: 1, rejections: rejections(7, 9000) },
    });
    expect(many).toContain(
      "Journaled rejections for that attempt (the 5 most recent of 7; 2 older omitted):",
    );
    expect(many).toContain("(message truncated: 9000 bytes, quoted 2048)");
    // The most recent are the ones kept.
    expect(many).toContain("envelope_invalid_6:");
    expect(many).not.toContain("envelope_invalid_1:");

    // A short message is quoted whole, with no note and no omission line.
    const short = text({
      attempt: 2,
      cause: "format_repair",
      previous: { attempt: 1, rejections: [{ reason: "artifact_empty", message: "it is empty" }] },
    });
    expect(short).toContain(
      "Journaled rejections for that attempt:\n- artifact_empty: it is empty",
    );
    expect(short).not.toContain("truncated");
    expect(short).not.toContain("older omitted");
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
