# Project assessment

Inspected 2026-09-14. This records repository evidence and distinguishes it from
the intended architecture. It is not a live runtime acceptance report.

## Current checkout

The working checkout was clean on `master` at `48691b6`, “Merge base project setup
from herdr-woof-old,” before this documentation change. It contained branding,
TypeScript configuration, package metadata, CI/release definitions, and shared
test helpers. It had no `docs/`, `src/`, `scripts/`, or `plugin/` directories.

The existing package description refers to durable graphs inside the caller's
Claude Code session. That describes the older direction. Its scripts and exports
also refer to source files that are absent from this checkout. Keep the tooling
as useful input, but do not infer working SDK, CLI or workflow behavior from the
manifest. Build/verification repair belongs to implementation, not this docs pass.

## Separate scaffold branch

`feat/plugin-scaffold` was inspected at `4c17bed`. It has its own worktree and adds
Herdr and Claude plugin manifests, launchers, CLI stubs, MCP protocol scaffolding,
tests and packaging checks. Its `docs/plugins.md` explicitly describes wiring,
not functioning orchestration; the MCP servers expose zero tools.

The inspected CLI's `runs` command prints `no runs` and `runtime` prints its run
directory environment value. Its `doctor` probes Herdr and Claude availability.
These are scaffolding, not evidence of run state or scheduling. This task did not
merge that branch, move its worktree, or modify its files.

## Earlier architecture draft

Git stash commit `38ccdfc` contains `docs/design/woof-v1-architecture-plan.md`.
The document labels itself a v2 draft for approval. Useful material includes
explicit agent ownership, bounded retries, correlated submissions, duplicate
handling, config provenance, state/events, liveness, and staged live acceptance.

Its mandatory worker MCP channel, rich in-envelope review findings, fixed package
split, Claude-only rollout, default permission bypass and no-resume scope are not
all settled by the conversation. The new docs retain the useful contracts and
separate requirements from those proposals. The stash remains untouched.

Version/protocol numbers and “verified this session” claims in that draft were
not re-proven against a local runtime here. They must not be copied into a support
matrix as current acceptance evidence.

## Older implementation: selective reuse

The sibling `herdr-woof-old` repository was inspected only for relevant source
and lessons:

| Material                  | Observed value                                                                                    | Reuse condition                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/herdr/client.ts`     | Typed socket requests, timeouts, subscription handling and loss callbacks.                        | Compare against the target Herdr API before copying; retain focused client tests.            |
| `src/loader/discovery.ts` | Explicit project/user/built-in precedence and `.woof/` discovery, with injectable roots.          | Adapt to the final workflow/config contract rather than importing the old engine.            |
| `docs/LEARNINGS.md`       | Recorded failures around lifecycle timing, duplicate effects, loader tests and production wiring. | Carry the failure scenarios into acceptance; do not copy obsolete architectural conclusions. |

The old lessons show why a green fake-runtime suite is insufficient. Idle can
precede completion hooks; transformed unit-test imports can hide actual runtime
loader incompatibilities; persistence recovery can repeat an effect; a system
can answer “queued” with no functioning production scheduler. Test observable
effects and complete flows in real processes.

Other old modules mentioned in the stashed draft, including Claude adapters and
MCP helpers, are reuse candidates requiring inspection. They were not fully
audited in this pass. Do not port the old server, runner, transcript parsing or
viewer wholesale merely because it already exists.

## Current external checks

Herdr documents agent start in an existing shell pane, lifecycle-aware prompt/wait
operations, and the possibility of ambiguous delivery after timeout. These support
the runtime/engine separation but do not validate Woof's result contract.
[Agent automation](https://herdr.dev/docs/agent-automation/).

The socket reference documents agent, worktree, metadata, plugin and event
operations. It supports using an adapter over the runtime; it does not establish
that the proposed Woof hosting and recovery behavior already works.
[Socket API](https://herdr.dev/docs/socket-api/).

The September 2026 product design conversation
was read through the connected conversation tool, including all 13 turns and the
final artifact correction. Later decisions take precedence over earlier options.
