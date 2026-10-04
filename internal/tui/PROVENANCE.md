# Terminal interface provenance

Inspected local donor snapshots before implementing this interface:

- herdr-orch commit `7aacbedb1a811e049a23ca9c90658f2a47f9bab9`,
  `cmd/herdr-orch/board.go`: Bubble Tea asynchronous read/update pattern,
  worker/state/detail rows, empty/error views and terminal lifecycle. The global
  backend, durable ID selection, event refresh, readiness fences and reviewed
  actions replace its session-local board RPC and one-second polling.
- herdr-projects commit `4e4548c3c43888e6be1c96906215998f07dc63f0`,
  `src/popup.rs`: scope picker wrapping, case-insensitive name/ID filtering,
  preserve highlighted selection when clearing the filter, first Escape clears
  a nonempty filter and second Escape closes. The corresponding donor test
  scenarios are translated in `model_test.go`. Choices now contain durable Woof
  IDs and canonical scope records rather than project file paths/slugs.
- herdr-projects `src/sidebar.rs` tests: inspect card state labels, one-line
  entries, retention of user-facing state text and concise sub-lines. State
  text remains explicit in all Woof rows; no state is communicated by color alone.

The UI reads existing daemon RPC data and never owns canonical state, queries
SQLite, controls panes, launches workers or runs workflows. Unicode wrapping and
terminal escape handling use Charm's maintained ANSI helpers rather than the
board's rune-count truncation. Retain `LICENSE.MIT` with these adapted portions.
