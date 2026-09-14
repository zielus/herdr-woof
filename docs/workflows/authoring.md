# Authoring a workflow

Status: authoring contract. Workflow syntax and API are not implemented yet.

A workflow defines how work progresses. Adding a new workflow should normally
mean adding a definition, roles and artifact contracts, without adding a special
case to the engine.

## Definition contents

| Part        | Author supplies                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Identity    | A name and a way to identify the definition used by a run.                                                |
| Input       | A schema for the structured task and context parameters.                                                  |
| Agents      | Named agents bound to role profiles; identity is separate from stage names.                               |
| Stages      | Assigned agent or supported deterministic operation, input mapping, required artifacts and result schema. |
| Transitions | A next stage or terminal outcome for every allowed gate result.                                           |
| Limits      | Finite loop, attempt, format-repair and wait budgets, plus an overall bound.                              |
| Result      | A small structured terminal result referring to accepted artifacts.                                       |

Define input mappings explicitly. For example, `review` receives the task,
acceptance criteria, current change reference, and verification evidence. `repair`
receives the accepted review artifact and belongs to `builder`. Do not send only
a rewritten prose summary of that artifact.

## Validation before execution

Reject missing input fields, unresolved roles, invalid limits, unknown transition
targets, and allowed outcomes without a transition. Check that every potentially
repeating route encounters a finite bound. The implementation should also catch
invalid artifact references and stage dependencies as early as its authoring
format permits.

Request construction and gate evaluation should be predictable functions of
validated input and accepted outputs. They must not secretly start agents or
perform untracked work. If executable TypeScript definitions are chosen, document
that loading them executes project code and test the actual supported runtime.

## Output and gates

Declare the substantive artifact and the envelope separately. A reviewer produces
a review file and a verdict; a planner produces a plan file and a completion
outcome. The engine checks contracts, then the workflow routes on validated
control fields.

Use distinct edges for content rejection and infrastructure failure. A reviewer
requesting changes is expected workflow behavior. A dead worker or an invalid
envelope is an execution problem handled by explicit policy.

## Extending the catalog

First implement [build-review](initial-workflows.md). Then add the planner stage
and plan artifact mapping for `plan-build-review` using the same engine. Keep an
externally authored small workflow in acceptance to prove that built-ins have no
special privileges.

Research/discussion workflows can assign researchers or critics and pass their
artifacts to a synthesis stage. They must also define termination and ownership.
Parallel execution is a separate scheduler capability; do not imply it exists
because several agents are declared in a definition.
