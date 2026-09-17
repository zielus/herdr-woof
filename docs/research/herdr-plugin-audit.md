# Herdr plugin audit: existing integration

Inspected 2026-09-17 against source at `87c9ca3` (0.1.2). This is a source and
saved-configuration audit, not a live Herdr acceptance report. No plugins were
installed, actions invoked, sessions inspected or personal settings changed.

## Findings

| Capability                  | Evidence                                                                                                                                                                                          | Next action                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Woof plugin registration    | The default saved `plugins.json` contains an enabled local `herdr-woof` entry pointing at this repository. Its cached version is 0.1.0; the current manifest is 0.1.2.                            | Existing registration; personal refresh is operator work, not a missing Woof implementation. |
| Woof actions                | The manifest and command handlers already implement `doctor`, `status`, `start`, `cancel`.                                                                                                        | Use and validate these actions in the intended project context.                              |
| Role and compact progress   | `src/host/metadata.ts` publishes `$woof-role` and `$woof` on assigned worker panes, plus `$woof` and a title on the host pane.                                                                    | Existing Woof token; presentation is separate operator configuration.                        |
| Refresh and notifications   | The publisher has TTLs, coalesced requests, bounded CLI calls, block/end notifications and nonfatal error handling. `test/host.process.test.ts` contains real-process tests against a fake Herdr. | Retain this publisher and verify publication/cleanup at the integration boundary.            |
| Saved sidebar configuration | The default `config.toml` has no `ui.sidebar` table, `status_indicators` setting or Woof references.                                                                                              | Outside Woof scope; the operator configures Herdr separately.                                |
| Workspace presets           | The saved registry lists enabled Herdr Plus 0.1.20; its installed README describes project templates and worktree-created/opened auto-layouts.                                                    | Outside Woof scope; do not implement a preset manager here.                                  |
| File viewer                 | An enabled Herdr file viewer registration and manifest are present.                                                                                                                               | Outside this metadata proposal; no file-viewer integration was verified.                     |

The registry is cached disk state, not proof of current server health or plugin
build success. The default config may differ from one explicitly selected by a
running client. These saved-configuration findings are historical context, not
Herdr setup tasks for Woof. The operator handles that configuration separately.

## What publication actually means today

The reporter is created by `hostWorkflow` when metadata options are available.
The CLI supplies those only with a Herdr environment and host pane. Linking the
plugin alone does not populate every existing agent: a managed run must execute
with that reporting context. Non-Woof agents retain native Herdr display fields.

Current worker tokens are a role plus `<stage> v<visit> a<attempt>` or `idle`.
The host token contains starting/running/blocked/outcome and may include counters.
On termination the worker token becomes `idle`; that token is assignment text,
not authoritative lifecycle observation. Use Herdr's `state_icon`/`state_text`
for actual working/idle/blocked indicators.

The publisher does not currently export separate kind/model, counter-free stage,
branch/worktree or workspace-level tokens. Although snapshots contain kind/model
and the SDK tracks work, those fields do not automatically appear in the sidebar.

## Woof follow-up

The likely small follow-up is publishing configured kind/model and a separate
current-stage token. Explicit worktree keys or workspace multi-run summaries are
conditional extensions: add them only if native context cannot satisfy the
operator's worktree distinction requirement.

## References and verification boundary

Inspected source: [manifest](../../herdr-plugin.toml),
[publisher](../../src/host/metadata.ts), [host wiring](../../src/host/run.ts),
[CLI metadata context](../../src/commands/run.ts),
[action handlers](../../src/commands/herdr.ts), and
[reporter process tests](../../test/host.process.test.ts).

Inspected local files: the default `~/.config/herdr/config.toml`,
`~/.config/herdr/plugins.json`, and the installed Herdr Plus README. Personal
configuration contents and unrelated registrations are not copied into this repo.

This task runs outside a Herdr-managed pane (`HERDR_ENV` is absent), so live
registration, action execution, token responses and visual behavior remain
unverified. See [plugin setup](../integrations/herdr-setup.md) for the shipped
checkout-based integration. Personal Herdr configuration is outside this work.

Offline verification performed during this audit: `bun run build` passed, then
`bun x vitest run test/host.process.test.ts -t metadata` passed all 3 selected
metadata/coalescing tests (11 unrelated cases were skipped by the name filter).
These tests use a fake Herdr in real processes; they do not establish that the
saved registration is loaded or that the sidebar displays the tokens. The full
product suite was not run for this documentation change.
