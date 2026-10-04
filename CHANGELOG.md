# Changelog

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
