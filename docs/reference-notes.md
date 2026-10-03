# Reference Repository Notes

Codex must inspect the local copies before implementation.

The user will provide paths to:

```text
ellingtonsp/herdr-orch
eliasstravik/herdr-projects
```

## `herdr-orch`

Use as the primary implementation donor for the runtime.

Inspect at minimum:

```text
herdr-plugin.toml
internal/herdr/
internal/rpc/
internal/store/
internal/daemon/
cmd/horch/
cmd/herdr-orch/
docs/design.md
docs/herdr-api-notes.md
```

Especially study:

- Herdr protocol behavior,
- subscriptions,
- worker startup,
- dispatch settlement,
- mailbox,
- `ask` / `reply`,
- daemon restart behavior,
- mutation uncertainty handling,
- release process verification,
- gates,
- TUI/Web code.

### Intentionally reject

Do not preserve:

```text
one daemon per Herdr session
one DB per Herdr session
$STATE/sessions/<session>/orch.db
```

Woof changes the ownership boundary to one global daemon/database.

## `herdr-projects`

Use mainly as a UX/configuration donor.

Inspect at minimum:

```text
src/profiles.rs
src/ticker.rs
src/inbox.rs
src/progress.rs
src/setup.rs
docs/operations.md
skill/COORDINATOR.md
```

Study:

- profile config,
- profile summaries,
- defaults/safety,
- ticker/nudge behavior,
- coordinator-facing context,
- file projection patterns,
- agent hooks.

### Intentionally reject

Do not copy the files-only persistence architecture as the Woof core.

Woof has a durable daemon/database and only uses files for projections/artifacts.

## Port versus rewrite

Prefer:

1. copying a proven component,
2. removing assumptions that no longer apply,
3. adapting tests,
4. preserving edge-case behavior,

over reimplementing from scratch.

However, do not contort imported code around the old per-session daemon architecture.

When code is tightly coupled to that model, rewrite the boundary cleanly.
