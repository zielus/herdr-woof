import { posix } from "node:path";

import { isId, isPlainObject, isPositiveInteger } from "../contracts/envelope.js";
import { TERMINAL_OUTCOMES, type Limits, type TerminalOutcome } from "../domain/types.js";
import {
  SHA256_PATTERN,
  check,
  exactKeysProblem,
  keysProblem,
  nonEmptyStringProblem,
} from "./record-fields.js";
import type { RecordBase } from "./records.js";

/**
 * Workflow-step records (composition, additive at schemaVersion 1). A workflow stage runs
 * another workflow as a child run: `stage.child_opened` opens the step's attempt when the child
 * run is open, and `stage.child_result` accepts the child's terminal result as the step's
 * output — its `RunResult` published as the accepted `result.json`, plus a copy of the child's
 * latest accepted artifact per child stage. Together they play the roles `attempt.opened` and
 * `submission.accepted` play for an agent stage, so gates, visit and round limits and
 * `latestAcceptedByStage` treat both alike.
 */

export const CHILD_RESULT_FILE = "result.json";

export interface StageChildOpenedRecord extends RecordBase {
  type: "stage.child_opened";
  stageId: string;
  visit: number;
  attempt: number;
  child: {
    runId: string;
    /** Absolute run directory of the child run (a sibling of the parent's). */
    runDir: string;
    workflow: { name: string; version: string };
  };
  /** Digest of the child's recorded `input.json`. */
  input: { sha256: string; bytes: number };
}

export interface ChildArtifactCopy {
  /** The child stage whose latest accepted artifact this copies. */
  stageId: string;
  /** Relative to the parent run: `accepted/<stage>/visit-<v>/attempt-<a>/<childStage>/<file>`. */
  acceptedPath: string;
  sha256: string;
  bytes: number;
}

export interface StageChildResultRecord extends RecordBase {
  type: "stage.child_result";
  stageId: string;
  visit: number;
  attempt: number;
  child: { runId: string; outcome: TerminalOutcome; reason: string; limit?: keyof Limits };
  /** "completed" exactly when the child completed. */
  status: "completed" | "failed";
  /** The child's terminal outcome. */
  verdict: TerminalOutcome;
  /** `rcpt-<seq>-<first 12 hex of the result's sha256>`. */
  receiptId: string;
  /** The child's `RunResult`, published as `accepted/<stage>/visit-<v>/attempt-<a>/result.json`. */
  artifact: { path: string; acceptedPath: string; sha256: string; bytes: number };
  artifacts: ChildArtifactCopy[];
}

/** Accepted directory of a workflow step's attempt, relative to the run directory. */
export function childAcceptedDir(stageId: string, visit: number, attempt: number): string {
  return `accepted/${stageId}/visit-${visit}/attempt-${attempt}`;
}

function stepProblem(value: Record<string, unknown>): string | undefined {
  return (
    check(isId(value["stageId"]), "stageId is invalid") ??
    check(isPositiveInteger(value["visit"]), "visit is invalid") ??
    check(isPositiveInteger(value["attempt"]), "attempt is invalid")
  );
}

function digestProblem(value: unknown, field: string): string | undefined {
  if (!isPlainObject(value)) return `${field} is not an object`;
  const bytes = value["bytes"];
  return (
    check(
      typeof value["sha256"] === "string" && SHA256_PATTERN.test(value["sha256"]),
      `${field}.sha256 is not 64 lowercase hex characters`,
    ) ??
    check(
      typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0,
      `${field}.bytes is not a non-negative safe integer`,
    )
  );
}

export function stageChildOpenedProblem(value: Record<string, unknown>): string | undefined {
  const problem =
    keysProblem(value, ["stageId", "visit", "attempt", "child", "input"]) ?? stepProblem(value);
  if (problem !== undefined) return problem;
  const child = value["child"];
  if (!isPlainObject(child)) return "child is not an object";
  const workflow = child["workflow"];
  const input = value["input"];
  return (
    exactKeysProblem(child, ["runId", "runDir", "workflow"], [], "child.") ??
    check(isId(child["runId"]), "child.runId is invalid") ??
    check(
      typeof child["runDir"] === "string" && posix.isAbsolute(child["runDir"]),
      "child.runDir is not absolute",
    ) ??
    (isPlainObject(workflow)
      ? (exactKeysProblem(workflow, ["name", "version"], [], "child.workflow.") ??
        check(isId(workflow["name"]), "child.workflow.name is invalid") ??
        check(isId(workflow["version"]), "child.workflow.version is invalid"))
      : "child.workflow is not an object") ??
    (isPlainObject(input)
      ? (exactKeysProblem(input, ["sha256", "bytes"], [], "input.") ??
        digestProblem(input, "input"))
      : "input is not an object")
  );
}

export function stageChildResultProblem(
  value: Record<string, unknown>,
  seq: number,
): string | undefined {
  const problem =
    keysProblem(value, [
      "stageId",
      "visit",
      "attempt",
      "child",
      "status",
      "verdict",
      "receiptId",
      "artifact",
      "artifacts",
    ]) ?? stepProblem(value);
  if (problem !== undefined) return problem;
  const dir = childAcceptedDir(
    value["stageId"] as string,
    value["visit"] as number,
    value["attempt"] as number,
  );
  const child = value["child"];
  if (!isPlainObject(child)) return "child is not an object";
  const outcome = child["outcome"];
  const childProblem =
    exactKeysProblem(child, ["runId", "outcome", "reason"], ["limit"], "child.") ??
    check(isId(child["runId"]), "child.runId is invalid") ??
    check(
      (TERMINAL_OUTCOMES as readonly unknown[]).includes(outcome),
      `child.outcome is not one of ${TERMINAL_OUTCOMES.join(", ")}`,
    ) ??
    nonEmptyStringProblem(child, "reason", "child.") ??
    check(
      (child["limit"] !== undefined) === (outcome === "exhausted"),
      "child.limit is present exactly when child.outcome is exhausted",
    ) ??
    check(value["verdict"] === outcome, "verdict is not the child's outcome") ??
    check(
      value["status"] === (outcome === "completed" ? "completed" : "failed"),
      'status is "completed" exactly when the child completed, else "failed"',
    );
  if (childProblem !== undefined) return childProblem;
  const artifact = value["artifact"];
  if (!isPlainObject(artifact)) return "artifact is not an object";
  const resultPath = `${dir}/${CHILD_RESULT_FILE}`;
  const artifactProblem =
    exactKeysProblem(artifact, ["path", "acceptedPath", "sha256", "bytes"], [], "artifact.") ??
    check(
      artifact["path"] === resultPath && artifact["acceptedPath"] === resultPath,
      `artifact.path and artifact.acceptedPath are not ${resultPath}`,
    ) ??
    digestProblem(artifact, "artifact") ??
    check(
      value["receiptId"] === `rcpt-${seq}-${String(artifact["sha256"]).slice(0, 12)}`,
      "receiptId does not match seq and the result's sha256",
    );
  if (artifactProblem !== undefined) return artifactProblem;
  const copies = value["artifacts"];
  if (!Array.isArray(copies)) return "artifacts is not an array";
  const seen = new Set<string>();
  for (const [index, copy] of copies.entries()) {
    const field = `artifacts[${index}]`;
    if (!isPlainObject(copy)) return `${field} is not an object`;
    const stageId = copy["stageId"];
    const acceptedPath = copy["acceptedPath"];
    const copyProblem =
      exactKeysProblem(copy, ["stageId", "acceptedPath", "sha256", "bytes"], [], `${field}.`) ??
      check(isId(stageId), `${field}.stageId is invalid`) ??
      check(!seen.has(stageId as string), `${field}.stageId repeats ${String(stageId)}`) ??
      check(
        typeof acceptedPath === "string" &&
          posix.dirname(acceptedPath) === `${dir}/${String(stageId)}` &&
          isId(posix.basename(acceptedPath)),
        `${field}.acceptedPath is not ${dir}/${String(stageId)}/<file>`,
      ) ??
      digestProblem(copy, field);
    if (copyProblem !== undefined) return copyProblem;
    seen.add(stageId as string);
  }
  return undefined;
}
