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

/** Longest run directory path admission accepts, in bytes; request size bounds assume it. */
export const MAX_RUN_DIR_BYTES = 512;

/**
 * Quoted prior-rejection data is bounded, because it is the one part of a
 * request that comes from a worker's own output rather than from the admitted
 * input. A rejection message can quote an artifact or an envelope, and the
 * number of rejections recorded for one attempt is not bounded either, so
 * without these caps a format-repair request could exceed MAX_REQUEST_BYTES for
 * an input admission already accepted (PR #7, request-bound.ts:112).
 */
export const MAX_REJECTION_MESSAGE_BYTES = 2 * 1024;
export const MAX_QUOTED_REJECTIONS = 5;

export interface ResolvedInput {
  label: string;
  /** Absolute path of the accepted copy or evidence file. */
  path: string;
  sha256: string;
  /** Accepted artifact identity; absent for check evidence. */
  accepted?: { stageId: string; visit: number; attempt: number; receiptId: string };
  /** Check id for check evidence. */
  checkId?: string;
  /** The run's input artifact label, for an input artifact (composition). */
  inputLabel?: string;
  /** The child stage whose copied artifact this is, for a workflow step's artifact. */
  childStage?: string;
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
  /** Fixed text the agent's kind adds to the submit section (its spec's `submitNote`). */
  submitNote?: string;
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
      // The most recent rejections are the ones worth reading; older ones are
      // counted, not quoted, so the block stays bounded however many there were.
      const quoted = rejections.slice(-MAX_QUOTED_REJECTIONS);
      const omitted = rejections.length - quoted.length;
      lines.push(
        omitted === 0
          ? "Journaled rejections for that attempt:"
          : `Journaled rejections for that attempt (the ${quoted.length} most recent of ${rejections.length}; ${omitted} older omitted):`,
      );
      for (const rejection of quoted)
        lines.push(`- ${rejection.reason}: ${clamp(oneLine(rejection.message))}`);
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
            ? `stage ${item.accepted.stageId}${item.childStage !== undefined ? ` (child stage ${item.childStage})` : ""} visit ${item.accepted.visit} attempt ${item.accepted.attempt}, receipt ${item.accepted.receiptId}, sha256 ${item.sha256}`
            : item.inputLabel !== undefined
              ? `run input artifact, sha256 ${item.sha256}`
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
    ...(input.submitNote !== undefined ? [input.submitNote] : []),
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

/**
 * A rejection message cut to MAX_REJECTION_MESSAGE_BYTES, with a note saying so.
 * Decoding the truncated bytes replaces a split trailing character with U+FFFD
 * rather than throwing, so any message is safe to quote.
 */
function clamp(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_REJECTION_MESSAGE_BYTES) return text;
  const kept = bytes.subarray(0, MAX_REJECTION_MESSAGE_BYTES).toString("utf8");
  return `${kept}… (message truncated: ${bytes.byteLength} bytes, quoted ${MAX_REJECTION_MESSAGE_BYTES})`;
}
