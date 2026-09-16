# Run inspector UI kit

A web UI for watching and inspecting Woof runs. No such UI exists in the repo (`docs/product/brief.md` defers a Web UI); this kit is designed from the domain model (`src/domain/types.ts`), `RunStatusView` (`src/inspect/status.ts`) and `RunEvent` (`src/observe/events.ts`).

Files: `index.html` (shell + state), `Shell.jsx` (header, runs sidebar), `RunDetail.jsx` (status bar, attention banner, overview/journal/artifacts), `data.js` (four fake runs: running, blocked, completed, exhausted+lost).

Interactions: pick a run, filter the sidebar, switch tabs, select stage attempts / journal records / artifacts, toggle dark/light (persisted), cancel a run (dialog → journal record → toast).

Layout: 44px header, 240px sidebar, main column with a 360px inspector column on the right. All copy uses engine vocabulary verbatim.
