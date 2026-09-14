import { canonicalJson } from "../contracts/canonical-json.js";
import type { AttemptCause, Revision } from "../domain/types.js";

/**
 * Worker request format v1 (p3): the Markdown text the scheduler persists,
 * hashes and delivers for one attempt. Rendering is deterministic for the same
 * input; paths are absolute. A format-repair request replaces the goal and task
 * with the journaled reasons the previous attempt was not accepted.
 */

/** Largest rendered request, in bytes. */
export const MAX_REQUEST_BYTES = 32 * 1024;

export interface ResolvedInput {
  label: string;
  /** Absolute path of the accepted copy or evidence file. */
  path: string;
  sha256: string;
  /** Accepted artifact identity; absent for check evidence. */
  accepted?: { stageId: string; visit: number; attempt: number; receiptId: string };
  /** Check id for check evidence. */
  checkId?: string;
}

export interface RenderRequestInput {
  runId: string;
  workflow: { name: string; version: string };
  agentId: string;
  role: string;
  stageId: string;
  visit: number;
  attempt: number;
  cause: AttemptCause;
  round: number;
  repository: string;
  revision: Revision;
  /** Absolute run directory. */
  runDir: string;
  artifactFile: string;
  verdicts: readonly string[];
  /** Command that runs `woof`, for example [process.execPath, "/abs/dist/cli.js"]. */
  submitCommand: readonly string[];
  goal: string;
  instructions: string;
  inputs: readonly ResolvedInput[];
  task?: { title: string; description: string; acceptanceCriteria: string[]; context?: unknown };
  roleInstructions?: string;
  /** Required for a format repair: the previous attempt and its journaled rejections. */
  previous?: {
    attempt: number;
    rejections: ReadonlyArray<{ reason: string; message: string }>;
  };
}

export type RenderRequestResult =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: "request_too_large"; bytes: number };

const CAUSE_LABELS: Record<AttemptCause, string> = {
  initial: "initial",
  format_repair: "format repair",
  work_retry: "work retry",
};

export function renderRequest(input: RenderRequestInput): RenderRequestResult {
  const artifactDirRel = `artifacts/${input.stageId}/visit-${input.visit}/attempt-${input.attempt}`;
  const artifactDir = `${input.runDir}/${artifactDirRel}`;
  const artifactPath = `${artifactDir}/${input.artifactFile}`;
  const envelopePath = `${artifactDir}/envelope.json`;
  const lines: string[] = [
    "# Woof work request v1",
    `Run ${input.runId} · workflow ${input.workflow.name}@${input.workflow.version} · you are agent ${input.agentId} (role ${input.role})`,
    `Stage ${input.stageId} · visit ${input.visit} · attempt ${input.attempt} · ${CAUSE_LABELS[input.cause]} · round ${input.round}`,
    `Repository (your working directory): ${input.repository}`,
    `Repository revision when this request was sent: tree ${input.revision.tree} (HEAD ${input.revision.head ?? "none"})`,
    "",
  ];

  if (input.cause === "format_repair") {
    const previous = input.previous;
    const previousAttempt = previous?.attempt ?? input.attempt - 1;
    lines.push(
      "## Why you are receiving this",
      `Your previous attempt (${input.stageId} visit ${input.visit} attempt ${previousAttempt}) ended without an accepted submission.`,
    );
    const rejections = previous?.rejections ?? [];
    if (rejections.length === 0) {
      lines.push("Journaled rejections for that attempt: none — no submission was recorded.");
    } else {
      lines.push("Journaled rejections for that attempt:");
      for (const rejection of rejections)
        lines.push(`- ${rejection.reason}: ${oneLine(rejection.message)}`);
    }
    lines.push(
      "Fix the output contract only. Do not redo the substantive work unless your artifact is missing.",
      `Your previous artifact, if any: ${input.runDir}/artifacts/${input.stageId}/visit-${input.visit}/attempt-${previousAttempt}/${input.artifactFile}`,
      "",
    );
  } else {
    lines.push("## Goal", input.goal, "");
    if (input.task !== undefined) {
      lines.push(
        "## Task",
        input.task.title,
        input.task.description,
        "",
        "### Acceptance criteria",
      );
      for (const criterion of input.task.acceptanceCriteria) lines.push(`- ${criterion}`);
      lines.push("");
      if (input.task.context !== undefined) {
        lines.push(
          "### Context",
          "```json",
          JSON.stringify(JSON.parse(canonicalJson(input.task.context)), null, 2),
          "```",
          "",
        );
      }
    }
    if (input.roleInstructions !== undefined) {
      lines.push("## Project instructions for your role", input.roleInstructions, "");
    }
    lines.push("## Inputs — read these exact files");
    if (input.inputs.length === 0) {
      lines.push("(none)");
    } else {
      for (const item of input.inputs) {
        const origin =
          item.accepted !== undefined
            ? `stage ${item.accepted.stageId} visit ${item.accepted.visit} attempt ${item.accepted.attempt}, receipt ${item.accepted.receiptId}, sha256 ${item.sha256}`
            : `check ${item.checkId ?? "?"} evidence, sha256 ${item.sha256}`;
        lines.push(`- ${item.label}: ${item.path} (${origin})`);
      }
    }
    lines.push("", "## What to do", input.instructions, "");
  }

  const verdictHint =
    input.verdicts.length === 0
      ? "null"
      : `one of ${input.verdicts.map((verdict) => JSON.stringify(verdict)).join(", ")}`;
  const envelope = `{"schemaVersion":1,"runId":${JSON.stringify(input.runId)},"agentId":${JSON.stringify(input.agentId)},"stageId":${JSON.stringify(input.stageId)},"visit":${input.visit},"attempt":${input.attempt},"status":"completed","verdict":<${verdictHint}>,"artifact":{"path":${JSON.stringify(`${artifactDirRel}/${input.artifactFile}`)},"sha256":"<fill>"}}`;
  const submit = [
    ...input.submitCommand,
    "submit",
    "--run-dir",
    input.runDir,
    "--envelope",
    envelopePath,
  ]
    .map(shellQuote)
    .join(" ");

  lines.push(
    "## Your artifact",
    `Write your artifact to exactly: ${artifactPath}`,
    "It must be a non-empty regular file inside that directory, at most 32 MiB.",
    "",
    "## Finish by submitting (required)",
    `1. sha256 of the artifact: \`shasum -a 256 ${shellQuote(artifactPath)}\` (or \`sha256sum\`).`,
    `2. Write this envelope to ${envelopePath}, filling sha256 and the verdict:`,
    `   ${envelope}`,
    '   Use status "failed" only if you could not do the work; still write an artifact saying why.',
    `3. Run: ${submit}`,
    '4. Exit 0 prints "accepted" or "duplicate": you are done; end your turn.',
    "   Exit 2 prints a rejection with reason and details: fix the envelope or artifact and run the same command again.",
    "   Exit 3 is an infrastructure problem: say so and end your turn.",
    `Do not edit files under ${input.runDir} other than ${artifactDir}. Do not message other agents.`,
    "",
  );

  const text = lines.join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_REQUEST_BYTES) return { ok: false, reason: "request_too_large", bytes };
  return { ok: true, text, bytes };
}

/** POSIX shell quoting: bare when safe, otherwise single-quoted. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}
