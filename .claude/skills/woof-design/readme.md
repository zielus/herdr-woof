# Woof Design System

Design system for **Woof**, an orchestration SDK and CLI for coding agents running through **Herdr** (a terminal multiplexer for agents). Woof runs bounded, journaled workflows (plan → build → verify → review → repair) across real agent sessions in Herdr panes and hands structured, hash-verified results back to the caller. Open source, developer-facing, v0.1.0 pre-release.

Names: **Woof** (product), `woof` (CLI, always lowercase, mono), **Herdr** (host). Audience: senior engineers and the coding agents that call the CLI.

## Sources

- GitHub: https://github.com/zielus/herdr-woof (private; branch `master`). Read: `README.md`, `assets/brand/README.md`, `docs/product/brief.md`, `docs/integrations/plugins.md`, `src/domain/types.ts`, `src/inspect/status.ts`, `src/commands/status.ts`, `src/observe/events.ts`. The repo is CLI/SDK only; it contains **no web UI, no site and no slides**. The UI kits here are designed from the domain model and CLI output shapes, not recreated from existing screens.
- Uploaded brand SVGs: `uploads/woof.svg`, `woof-ink.svg`, `tile-dark.svg`, `tile-light.svg` (copied to `assets/brand/`).
- Brief from the user (palette, feel, voice) — see below.

Readers with repo access should explore `docs/architecture/*.md` for the exact vocabulary of records, states and reasons before designing new surfaces.

## Surfaces

1. **Run inspector (web UI)** — watch and inspect runs: stages, visits, attempts, gates, journal events, artifacts, liveness. `ui_kits/inspector/`.
2. **GitHub Pages site** for the plugin — install, commands, exit codes. `ui_kits/site/`.
3. **Slides** — talk/README-style presentation. `slides/`.

## Domain vocabulary (use these words exactly)

- Run status: `created` `starting` `running` `blocked` `completed` `failed` `cancelled` `exhausted`.
- Owner liveness: `unhosted` `alive` `lost` `exited`.
- Agent activity: `idle` `working` `blocked` `done`.
- Gate decision: `pass` `reject`. Verdicts: `pass` `fail`. Terminal outcome for limits: `exhausted`.
- Attempt status: `open` `superseded` `accepted` `abandoned`. Attempt cause: `initial` `format_repair` `work_retry`.
- Delivery: `started` `not_delivered` `ambiguous`; reasons like `observed_working`, `timeout`, `protocol_error`.
- Block reasons: `blocked_on_input`, `startup_blocked`.
- Journal record types: `run.opened` `agent.assigned` `attempt.opened` `request.dispatched` `submission.accepted` `submission.rejected` `submission.duplicate` `gate.recorded` `run.blocked` `run.unblocked` `delivery.reconciled` `run.terminated`.
- Exit codes: 0 completed · 1 usage · 2 rejected · 3 infrastructure · 4 failed · 5 exhausted · 6 cancelled · 7 timeout · 8 owner gone · 9 blocked.
- Identifiers: `stage v<visit> a<attempt> r<round>` (e.g. `review v2 a1 r2`), run ids like `br-…`, sha256 hashes shortened to 12 chars with full value on hover/copy.

## CONTENT FUNDAMENTALS

**Tone.** Plain, honest, specific. Sentences state what exists and what does not: "It does not delegate agents outside a workflow, resume a crashed run, or run parallel work within a run." No superlatives, no exclamation points, no "seamless", "powerful", "effortless".

**Person.** Documentation addresses the reader as "you" sparingly; most sentences have the product or the command as subject ("`woof status` polls until…", "Woof surfaces an untrusted repository as…"). UI copy is third-person declarative status: "Owner lost. Confirmed by two probes 4.1 s apart." Never "we".

**Casing.** Sentence case everywhere: headings, buttons, labels, table headers. Product name "Woof" is capitalised; the binary `woof`, commands, flags, states, reasons and record types are lowercase and always set in monospace: `run.blocked{reason:"startup_blocked"}`. Never title-case a state (`Blocked` ✗ → `blocked` ✓ in mono; in a sentence, "The run is blocked").

**Precision over friendliness.** Numbers carry units (`2000 ms`, `32 MiB`, `540000`). Reasons are quoted verbatim from the engine, never paraphrased in UI: show `requiredAction` text as-is.

**Empty and error states** say what is missing and what resolves it: "No terminal record. The owner exited before the run recorded its end. Resolve with `woof run cancel <run-dir>`."

**Emoji.** Never. No decorative unicode either; the only symbols are ASCII/box characters that a terminal would print (`→`, `·`, `—`, `✓`/`✗` only inside status chips).

**Examples of good copy**
- "Read-only: no journal lock, no Herdr."
- "Exit 8 — the owner is gone without a recorded outcome."
- "3 of 3 rounds used. Limit `maxRounds` reached."
- Button: "Cancel run" (not "Cancel Run", not "Abort").
- Empty table: "No runs in `~/.woof/runs`."

## VISUAL FOUNDATIONS

**Theme.** Dark is primary (`:root`), light is `[data-theme="light"]`. Both are required for every screen. Dark surfaces: app `#121219`, surface `#1c1c28` (brand charcoal), raised `#242433`. Light surfaces: app `#f0f0fc` (brand pale lavender), surface `#ffffff`.

**Color.** Lavender `#c3c7f5` is the single accent: primary buttons, links, focus rings, active/selected markers, the `working` state. In light mode the primary button flips to charcoal with lavender text (mirrors the tile-light logo). Everything else is neutral grey-violet. State colors are the only other hues and they mean one thing each: teal = pass/completed/accepted; rose = fail/failed/rejected/corrupt; amber = blocked/attention; grey = lost/exited/idle/abandoned; lavender = working/running. Never use state colors decoratively. No gradients anywhere.

**Type.** Geist (humanist sans) for prose, headings, labels. Source Code Pro (mono) for everything the CLI would print: ids, hashes, commands, journal lines, exit codes, states, reasons, paths, timestamps, numbers in tables. Body 14px/1.5, UI base 13px, mono 13px/1.6, small 12px, labels 11px medium with 0.04em tracking (uppercase only for tiny section labels in the inspector). Display 48px medium, tight tracking. Both are Google Fonts substitutes — no brand font files were supplied.

**Spacing.** 2/4/6/8/12/16/20/24/32/48/64/96. Dense but breathable: table rows 28px (24px dense), controls 28px (36px large), panel padding 12–16px, section gaps 24–32px. Sidebar 240px, inspector pane 360px, content max 1120px, prose max 680px.

**Radii.** 3px chips/inputs-in-tables, 5px controls/cards/inputs, 8px dialogs/large panels, pill for status chips only. Brand tiles use 6.25% (64/1024).

**Borders & shadows.** 1px borders are the primary separator (`--border-subtle` inside panels, `--border-default` around them). Shadows are nearly absent: `--shadow-1` on popovers, `--shadow-2` on dialogs. No inner shadows, no glows.

**Cards/panels.** Flat surface color, 1px border, 5px radius, no shadow. Section headers inside a panel: 11px label, muted, with a 1px bottom border. No colored left borders.

**Backgrounds.** Solid. No imagery, illustration, textures or patterns. The only "graphic" is the Woof mark and diff/journal text blocks themselves.

**Interaction states.** Hover: background steps one level (`--bg-hover`); text does not change color. Active/press: `--bg-active`, no scale. Focus: 2px surface gap + 2px lavender ring (`--focus-ring`). Disabled: 45% opacity, cursor not-allowed. Selected row: `--accent-subtle` background plus 2px accent bar on the left edge of the row (rows only, never cards).

**Motion.** Minimal. 80ms for color/background, 140ms ease-out for panel open/close and chip enter. No bounces, no fades longer than 140ms, no springs. Live indicators (`working`, `alive` heartbeat) use a 1.2s opacity pulse on a 6px dot — the only looping animation.

**Transparency & blur.** None, except the `*-subtle` state tints (10–14% alpha) and the selection color. No backdrop blur.

**Layout.** Inspector: fixed left sidebar (runs list), main column, optional right inspector pane. Header 44px, sticky. Tables use tabular mono numerals, right-aligned counts. Timelines are vertical, one row per stage visit, with attempts nested and indented 16px.

**Data views.** Diff-like artifact views use `--diff-add-bg/--diff-del-bg` full-row tints with `+`/`-` gutters; journal lines are `seq ts type subject` in mono with type colored by family (run.* accent, gate.* pass/fail, submission.rejected rose, run.blocked amber).

**Imagery.** None. Do not add stock photography or illustrations.

## ICONOGRAPHY

- **Logo:** symbol-only mark, four vector paths, no lettering. Four files in `assets/brand/`: `woof.svg` (lavender, for dark), `woof-ink.svg` (charcoal, for light), `tile-dark.svg`, `tile-light.svg`. PNG exports at 32/64/256 in `assets/brand/icons/<variant>/`, `favicon.ico`. Use the mark at 32px or larger; 16px only as favicon. Never recolor the mark outside lavender/charcoal; never add a wordmark — set "Woof" in Geist medium next to it.
- **UI icons:** the repo ships none. This system uses **Lucide** (CDN, 1.5px stroke at 16px, `stroke-width: 1.5`) via `<script src="https://unpkg.com/lucide@latest">` or the inline SVG paths copied into `components/core/Icon.jsx`. Lucide was chosen for its terminal-like thin geometry. Substitution flagged — swap for a bespoke set if one is made.
- **Status glyphs** live in chips, not icons: a 6px dot colored by state. Pass/fail chips may add `✓`/`✗`.
- **Emoji:** never. **Unicode as icons:** only `→ · —` in text.

## Intentional additions

- `Icon` — thin wrapper over Lucide paths so kits don't inline SVG.
- `ThemeToggle` pattern (in kits) — dark/light is required and has no source counterpart.

## Index

- `styles.css` → `tokens/fonts.css`, `colors.css`, `typography.css`, `spacing.css`, `base.css`
- `assets/brand/` — logo SVGs, PNG exports, favicon
- `guidelines/` — foundation cards (Colors, Type, Spacing, Brand)
- `components/core/` — Button, IconButton, Input, Select, Checkbox, Switch, Chip (status), Badge, Tag, Tabs, Card, Dialog, Toast, Tooltip, Table, Timeline, JournalLine, Hash, KeyValue, Icon, Logo
- `ui_kits/inspector/` — Run inspector web UI (runs list, run detail, journal, artifacts)
- `ui_kits/site/` — GitHub Pages plugin site
- `slides/` — slide templates (Title, Section, Bullets, Code, Table, Closing)
- `thumbnail.html`, `SKILL.md`, `github.md`
