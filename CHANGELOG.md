# Changelog

## 1.1.0 (2026-10-05)

- Workers launched by `woofd` get default permission arguments for their own
  coordination flow: a Claude `--settings` allow list, and for Codex
  `--no-daemon` with a permission profile allowing only the woofd socket.
  Skipped when the launch already carries permission or sandbox flags; disable
  with `defaults.worker_permissions: false`.
- Blocked-worker alerts: a worker blocked for `--blocked-timeout` (20s) alerts
  the run's invoker worker, or the human, once per continuous block; an
  unresolved block escalates once to the human after
  `--blocked-escalation-timeout` (5m). Alerts never settle, fail, nudge or
  redispatch.
- When Herdr does not show a toast, woofd falls back to an OS notification
  (`osascript` on macOS, `notify-send` on Linux).
- A blocked dispatch is no longer also reported as `no_activity`.
- The CLI only changes the state directory mode when it is wrong.
- `using-woof` command shapes match the default permission rules.

## 1.0.0 (2026-10-05)

Complete rewrite of Woof in Go. It replaces the TypeScript workflow engine
published as `herdr-woof` 0.x (npm package and plugin id `herdr-woof`), which
now lives at [zielus/herdr-woof-legacy](https://github.com/zielus/herdr-woof-legacy).
There is no data migration from 0.x; old state is left untouched.

- One global `woofd` owns a canonical SQLite database and connects to multiple
  Herdr sessions; the `woof` CLI talks to it over Unix socket RPC.
- Durable logical workers with launch profiles, adoption and recovery that
  survive pane changes.
- Durable messages, questions, handoff files and a replayable event log.
- Dispatches that settle only on an explicit report plus lifecycle evidence.
- Minimal decision gates, protected release/stop, and uncertain-mutation
  tracking with explicit resolution.
- `woof tui` terminal interface with inbox and decision handling.
- Native time scheduler sending durable messages and dispatches.
- Herdr plugin (`id = "woof"`): installs verified prebuilt binaries for
  macOS/Linux on amd64/arm64, falling back to a source build.
