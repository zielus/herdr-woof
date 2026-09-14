# Architecture decisions

Status: synthesis of the product conversation, 2026-09-14. “Settled” below means
the direction expressed by that source and the current request, not approval of
every detail in a previous assistant-generated draft.

## Settled product direction

| Decision                            | Consequence                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| One Woof product                    | Both plugins and the SDK share concepts; orchestration is part of Woof.        |
| SDK owns the engine                 | Gates, retries, validation and run state are reusable outside a plugin UI.     |
| Herdr remains runtime               | Reuse its agent/session/pane/worktree operations and integration capabilities. |
| Agent callers come first            | Rich structured input is primary; manual CLI ergonomics are secondary.         |
| Identity differs from stage         | Repair can reuse the builder; stage changes do not imply new sessions.         |
| Artifacts carry substantive work    | Review files are required; envelopes carry control data and references.        |
| Engine validates results            | Idle state and a completion claim cannot by themselves satisfy a stage.        |
| Every loop is bounded               | Work retries, format repairs, rounds and waits have explicit policies.         |
| Configuration has two scopes        | User defaults and project overrides work independently of Claude Code.         |
| Observability is part of the engine | Snapshots and updates support multiple consumers from the start.               |
| MCP is optional                     | Core invocation and result submission have a non-MCP path.                     |
| TUI later                           | Establish the observation contract now; defer the renderer.                    |

## Superseded recommendations

| Earlier idea                                                | Current resolution                                                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Woof is only developer UX; Horde owns loops                 | Woof is the product and `HerdrAgentsSDK` contains orchestration.                                                  |
| Review findings live in a rich JSON response; file optional | The review artifact is canonical and required; JSON is the control envelope.                                      |
| Worker results only through MCP `woof_submit`               | Keep submission validation and idempotence; remove the transport requirement.                                     |
| Reject artifact/file protocols altogether                   | Evaluate publication and acknowledgement semantics; do not reject the user's required artifacts.                  |
| Stashed Claude-only workers and automatic permission bypass | These are implementation proposals, not requirements; capability and permission policies need explicit decisions. |
| Fixed multi-package layout, YAML or fluent workflow API     | Examples illustrate possible shapes; none is a settled packaging or syntax contract.                              |

## Open implementation decisions

| Choice                 | Status                                    | Recommendation                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Result submission      | **Prototyped (p1)**                       | Artifact publication plus a worker-callable CLI bridge into the SDK (D1).         | Produced: `test/submit.cli.test.ts`, `test/journal.process.test.ts` (real-process tests: malformed, partial, duplicate and stale submissions); live worker completion in `docs/research/result-handoff-live.log`; commit `d1c3ee4`.                                                                                                               |
| Run hosting            | Open                                      | Evaluate one process per run in a Herdr-managed pane.                             | Needed: readiness, cancellation, caller exit, runtime death and two concurrent runs.                                                                                                                                                                                                                                                              |
| Persistence and resume | Open — journal exists, resume not claimed | Keep inspectable state/artifacts; specify crash behavior before promising resume. | Produced: the append-only `journal.jsonl` (`src/journal/`) exists and derives attempt/acceptance state by replay. Needed: lost-owner detection and no duplicate effects after any supported recovery — crash resume is explicitly not claimed.                                                                                                    |
| Module/package layout  | Open                                      | Start with explicit boundaries in the existing TypeScript project.                | Needed: independently usable SDK and no plugin/UI dependency in the engine.                                                                                                                                                                                                                                                                       |
| Workflow syntax        | Open                                      | Use TypeScript first if the existing loader remains suitable.                     | Needed: two complete workflows and real runtime loader tests.                                                                                                                                                                                                                                                                                     |
| Configuration          | Open                                      | Extend `.woof/` and `~/.woof/` precedent with documented precedence.              | Needed: nested project/worktree discovery, provenance, validation and override cases.                                                                                                                                                                                                                                                             |
| Worker providers       | Open                                      | Keep a capability boundary; choose and document the initial tested set.           | Needed: actual launch, prompt, readiness, blocking and result handoff per provider.                                                                                                                                                                                                                                                               |
| Artifact contract      | Open — p1 subset prototyped               | Immutable accepted versions with small parseable control metadata.                | Produced: the p1 subset — immutable accepted copy under `accepted/<stage>/visit-<n>/attempt-<m>/`, scoped to that attempt's own artifact directory (`test/submit.cli.test.ts`, `test/engine-paths.cli.test.ts`). Needed: metadata/verdict agreement between the artifact and the envelope, and per-stage structural schemas, are not implemented. |

Resolve these into a spec and bounded tickets. Reopen product direction only when
new evidence shows a real conflict. Avoid repeating the entire design discussion
to choose a filename or helper function.

## Sources

The [conversation](https://chatgpt.com/c/6aa71569-4e7c-83ed-b6d6-03992919a7c4)
provides the direction and final artifact correction. The
[project assessment](../research/project-assessment.md) identifies the stashed
draft and scaffold branch as separate historical inputs.
