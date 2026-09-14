# Configuration and project context

## Required behavior

Woof has reusable user-level defaults and project-local overrides. Projects can
version roles, workflow definitions, model preferences, and context with their
code. The SDK accepts resolved configuration; it does not depend on Claude Code
to resolve settings or on a host plugin being installed.

Conceptual precedence is project → user → built-in. Explicit per-run overrides,
if exposed, must be validated, visible to the caller, and recorded with the run.
Resolving configuration must explain which source supplied each effective role,
workflow and setting.

Role, agent kind and model are separate. For example, `reviewer` is a project
responsibility that can resolve to a supported coding-agent CLI and a configured
model. Model identifiers in the earlier conversation were examples, not permanent
defaults or a tested provider support matrix.

## Recommended layout

The old loader already discovers project `.woof/` and user `~/.woof/` workflow
directories. Preserve those conventions unless a concrete conflict appears.
This proposed layout extends that precedent; it is not implemented here:

```text
~/.woof/
  woof.json
  roles/
  workflows/
  runs/

<project>/.woof/
  woof.json
  roles/
  workflows/
```

Prefer whole-definition replacement for named roles and workflows. For scalar
defaults, define field-level precedence explicitly. Avoid an implicit recursive
merge that silently combines incompatible permission settings or workflow edges.
Exact filenames, schemas, and root discovery are open implementation choices.

Do not invent project-local `.herdr/` semantics. Keep Woof project configuration
separate from Herdr's own installation, runtime and UI configuration. A plugin
adapter can map host-provided directories into explicit Woof configuration.

## Run resolution

At admission, resolve the project root and runtime target, discover the workflow,
validate its input, resolve every role, collect declared context, and validate
limits and required capabilities. Missing roles, invalid settings, or unavailable
providers must fail with an explanation before workers are launched.

Capture the effective configuration and provenance with the run. Editing a role
file halfway through a review loop must not silently change the builder's model
or permissions. If a run intentionally changes configuration, record it as an
explicit operation.

Context files are resolved relative to a documented root, with size bounds and
visible handling of missing or truncated content. Separate shareable project
settings from private runtime credentials and generated run artifacts.

Permission policy belongs to explicit role/project configuration. The earlier
draft's automatic `bypassPermissions` default and automatic trust-dialog dismissal
are not product requirements. Represent a permission block accurately and expose
the required user action.

## Decisions still needed

Choose root discovery for nested projects and worktrees, role serialization,
configuration schema/versioning, run storage location, artifact retention, and
per-run override rules during specification. Verify actual provider flags in the
target environment rather than copying flags from historical planning notes.

See [project assessment](../research/project-assessment.md) for the inspected
loader precedent and [acceptance criteria](../acceptance/v1.md) for precedence tests.
