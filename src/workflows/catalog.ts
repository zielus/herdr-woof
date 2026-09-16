import type { WorkflowDefinition } from "../scheduler/definition.js";
import { buildReviewWorkflow } from "./build-review.js";
import { planBuildReviewWorkflow } from "./plan-build-review.js";

/**
 * The built-in workflow catalog (p5 D2): one name-keyed registry both
 * configuration resolution and the run host read, so adding a workflow never
 * adds a branch that names one. The record has no prototype, so a workflow
 * named `constructor` or `toString` is `workflow_not_found` rather than an
 * inherited function; every lookup goes through `builtInWorkflow`, which
 * consults own keys only.
 */
export const BUILT_IN_WORKFLOWS: Record<string, WorkflowDefinition<unknown>> = Object.assign(
  Object.create(null) as Record<string, WorkflowDefinition<unknown>>,
  {
    [buildReviewWorkflow.name]: buildReviewWorkflow as unknown as WorkflowDefinition<unknown>,
    [planBuildReviewWorkflow.name]:
      planBuildReviewWorkflow as unknown as WorkflowDefinition<unknown>,
  },
);

/** The built-in definition of that name, or undefined; inherited keys are never found. */
export function builtInWorkflow(name: string): WorkflowDefinition<unknown> | undefined {
  return Object.hasOwn(BUILT_IN_WORKFLOWS, name) ? BUILT_IN_WORKFLOWS[name] : undefined;
}

/** Built-in workflow names, in catalog order. */
export function builtInWorkflowNames(): string[] {
  return Object.keys(BUILT_IN_WORKFLOWS);
}
