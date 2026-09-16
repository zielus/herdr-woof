import { MAX_COUNT_LIMIT } from "../domain/types.js";
import {
  agentStageOf,
  type RequestContext,
  type WorkflowDefinition,
} from "../scheduler/definition.js";
import {
  MAX_QUOTED_REJECTIONS,
  MAX_REJECTION_MESSAGE_BYTES,
  MAX_RUN_DIR_BYTES,
  renderRequest,
  type ResolvedInput,
} from "../scheduler/request.js";

/**
 * Admission-time bound on the exact rendered request, shared by the built-in
 * workflows (p5 T2). A definition names the stages whose requests can be its
 * largest, and this renders each one with a run directory and submit command at
 * the admitted maximum length (plus room for symlink resolution) and maximal
 * counters, ids and digests, so an input whose request would only overflow
 * mid-run is refused at admission instead.
 *
 * Every input the stage's `request()` names is resolved to a synthetic accepted
 * copy or check evidence of maximum length, so a stage that carries more inputs
 * than another is measured as larger, which is exactly why the bound exists.
 */

/** A stage whose request is a candidate for the largest, and the gate that entered it. */
export interface RequestBoundCase {
  stageId: string;
  /**
   * The synthetic gate that entered the stage; a check gate when `kind` is
   * "check", and null for the start stage's first visit.
   */
  enteredBy: { kind: "stage" | "check"; gate: string } | null;
}

/** An absolute path of the admitted maximum run directory length, plus room for symlink resolution. */
function longPath(char: string): string {
  return `/${char.repeat(MAX_RUN_DIR_BYTES + 127)}`;
}

export function largestRequestBytes<Input>(
  definition: WorkflowDefinition<Input>,
  input: Input,
  cases: readonly RequestBoundCase[],
  options: { historyStageId?: string } = {},
): number {
  const runDir = longPath("r");
  const hex = "f".repeat(64);
  const counter = MAX_COUNT_LIMIT;
  const seq = Number.MAX_SAFE_INTEGER;
  const receiptId = `rcpt-${seq}-${hex.slice(0, 12)}`;
  type Entered = NonNullable<RequestContext<Input>["enteredBy"]>;
  // One synthetic gate stands in for every gate a request may read out of history:
  // the latest accepted artifact of the stage the definition looks back at.
  const historyGate = {
    kind: "stage",
    gate: options.historyStageId ?? definition.start,
    subject: {
      stageId: options.historyStageId ?? definition.start,
      visit: counter,
      attempt: counter,
      acceptedSeq: seq,
      receiptId,
    },
    revision: { head: hex, tree: hex },
  } as unknown as Entered;

  let largest = 0;
  for (const item of cases) {
    const stage = agentStageOf(definition, item.stageId);
    if (stage === undefined) continue;
    const enteredBy =
      item.enteredBy === null
        ? null
        : ({
            ...historyGate,
            kind: item.enteredBy.kind,
            gate: item.enteredBy.gate,
          } as Entered);
    const request = stage.request({
      input,
      runId: "r".repeat(128),
      history: { gates: [historyGate], latestAccepted: {} },
      stageId: item.stageId,
      visit: counter,
      attempt: counter,
      round: counter,
      enteredBy,
    });
    const inputs: ResolvedInput[] = request.inputs.map((ref) => {
      if ("checkId" in ref.from) {
        return {
          label: ref.label,
          path: `${runDir}/checks/${ref.from.checkId}/${item.stageId}-v${counter}-a${counter}/output.log`,
          sha256: hex,
          checkId: ref.from.checkId,
        };
      }
      const source = agentStageOf(definition, ref.from.stageId);
      return {
        label: ref.label,
        path: `${runDir}/accepted/${ref.from.stageId}/visit-${counter}/attempt-${counter}/${source?.artifactFile ?? "artifact"}`,
        sha256: hex,
        accepted: { stageId: ref.from.stageId, visit: counter, attempt: counter, receiptId },
      };
    });
    const rendered = renderRequest({
      runId: "r".repeat(128),
      workflow: { name: definition.name, version: definition.version },
      agentId: stage.agentId,
      role: stage.agentId,
      stageId: item.stageId,
      visit: counter,
      attempt: counter,
      cause: "work_retry",
      round: counter,
      repository: definition.repository(input),
      revision: { head: hex, tree: hex },
      runDir,
      artifactFile: stage.artifactFile,
      verdicts: stage.verdicts,
      submitCommand: [longPath("n"), longPath("c")],
      goal: request.goal,
      instructions: request.instructions,
      inputs,
      ...(request.task !== undefined ? { task: request.task } : {}),
      ...(request.roleInstructions !== undefined
        ? { roleInstructions: request.roleInstructions }
        : {}),
    });
    // The same stage's format-repair request, which replaces the goal, task and
    // inputs with the previous attempt's journaled rejections. Those messages come
    // from a worker's own output, not from the admitted input, so the renderer
    // caps them; this renders that cap's worst case so an input is never admitted
    // whose format repair could then exceed MAX_REQUEST_BYTES (PR #7).
    const repair = renderRequest({
      runId: "r".repeat(128),
      workflow: { name: definition.name, version: definition.version },
      agentId: stage.agentId,
      role: stage.agentId,
      stageId: item.stageId,
      visit: counter,
      attempt: counter,
      cause: "format_repair",
      round: counter,
      repository: definition.repository(input),
      revision: { head: hex, tree: hex },
      runDir,
      artifactFile: stage.artifactFile,
      verdicts: stage.verdicts,
      submitCommand: [longPath("n"), longPath("c")],
      goal: request.goal,
      instructions: request.instructions,
      inputs: [],
      previous: {
        attempt: counter,
        rejections: Array.from({ length: MAX_QUOTED_REJECTIONS }, () => ({
          reason: "r".repeat(64),
          // One byte past the cap, so the truncation note is rendered too.
          message: "m".repeat(MAX_REJECTION_MESSAGE_BYTES + 1),
        })),
      },
    });
    largest = Math.max(largest, rendered.bytes, repair.bytes);
  }
  return largest;
}
