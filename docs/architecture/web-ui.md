# Web UI

Status: base only. `woof ui` serves a dashboard for the runs under a runs
directory, over the engine's own functions. It is an inspection API, not a
read-only one: every route but one is a read, and `POST /api/runs/:runId/cancel`
records `run.terminated{outcome:"cancelled"}`. It is the starting point for
prototyping, not a finished interface; the gaps below are real and are not
worked around anywhere in the code.

`AGENTS.md` puts a TUI or Web UI at development-order item 4, after the SDK.
What exists here is the consumer the
[observability contract](observability.md) asks for: something that follows an
active run, disconnects, reconnects and reaches the same visible state as a
fresh snapshot.

## What exists now

`woof ui [--port <n>] [--host <addr>] [--runs-dir <dir>] [--token <secret>]
[--allow-host <name>] [--allow-origin <origin>] [--poll-ms <n>] [--no-open]`
starts one process that serves both the API and the built single-page app, binds
`127.0.0.1:4317` by default, prints one JSON line naming the URL, and keeps
running until it is interrupted.

The server is plain `node:http` in `src/web/`. It adds no runtime dependency:
the package still declares none. Every route is a passthrough to a function the
engine already exports.

| Route                          | Engine call     | Notes                                                                                                                                                                                                                                                                |
| ------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/runs`                | `listRuns`      | Every run that has not ended plus the twenty most recent that have, as `woof runs` lists them. Each entry is enriched with `activeAttempts` and `attention` from `readRunStatus`, so the list can name the stage a run is on without the browser fetching every run. |
| `GET /api/runs/:runId`         | `readRunStatus` | Returns `status` (the compact `woof.run.status` view), `result` (once terminal) and the full `snapshot` in one response.                                                                                                                                             |
| `GET /api/runs/:runId/events`  | `streamEvents`  | Server-sent events. Each run event is a default `message` whose SSE `id` is the event's cursor. Resumable with `?after=<cursor>` or `Last-Event-ID`.                                                                                                                 |
| `POST /api/runs/:runId/cancel` | `terminateRun`  | The same call `woof run cancel` makes.                                                                                                                                                                                                                               |
| `GET /api/capabilities`        | —               | What this server can do, so the UI disables an action because the server said so rather than because it hard-codes the same list.                                                                                                                                    |

A run id is resolved to a directory by listing the runs directory and matching
the recorded run id — never by joining the request path onto a filesystem path.
The lookup lists every run, including terminal ones past the default cap, so an
older finished run stays reachable by id.

Reads take no journal lock and never contact Herdr, exactly as the CLI's
inspection commands do not. The UI is never a second journal writer.

### The event stream

The stream is the CLI's own follow loop (`src/observe/stream.ts`), not a
second one. `subscribeEvents` by itself never ends on `run.terminated`, so a
naive pipe would hold every connection open for the life of the process.

- Each event's SSE `id` is the cursor positioned after it. A browser reconnect
  sends `Last-Event-ID` and the server resumes after it.
- Delivery across a reconnect is at-least-once; the client dedupes by `seq`.
- A cursor that cannot resume arrives as a named `resync` event. That never
  means "repair part of the stream": the client drops the feed, refetches the
  snapshot and opens a fresh stream. This is the engine's rule, not a UI choice.
- The stream ends with a named `end` event carrying
  `{cursor, terminal, reason}`. The client closes the connection on it, so a
  terminated run does not reconnect into an immediately-ending stream forever.
- Shutting the server down ends every open stream with that same `end` event
  before the sockets close, so a browser sees a finished stream rather than a
  dropped connection it would try to reconnect. The order matters and is
  deliberate: the listener stops accepting first, then the tracked streams are
  drained, then whatever is left is closed, and only then is the close awaited.
  Closing the listener does not stop a request already in flight on an open
  keep-alive connection, so a stream admitted during the drain is registered and
  ended at once — it gets its `end` frame too, rather than a destroyed socket.
- At most **64 concurrent streams**. The 65th is refused with `503`
  `too_many_streams` and its reason, never accepted into an unbounded set of
  journal pollers. Each stream polls its journal every `--poll-ms` (250 ms by
  default).

### Actions, and the ones that do not exist

Cancel is the only operator action the engine has. It goes through
`terminateRun`, which takes the journal lock, replays the run's state and
refuses an invalid transition, so cancelling a run a scheduler is actively
hosting is safe without checking liveness first.

Everything else answers `501` with the engine's own reason, and renders in the
UI as a disabled control with that reason attached:

- **Answer a blocked agent** — `answer_blocked_unsupported`. Nothing in Woof
  answers a permission prompt. A block clears when the runtime observes the
  agent leave `blocked`, when the run is cancelled, or when `blockedWaitMs`
  elapses into `exhausted`. The UI shows `attention.blocked.requiredAction`
  verbatim and says where to act.
- **Retry** — `retry_unsupported`. Work retry and format repair are scheduler
  decisions. There is no call that retries an attempt, resumes a lost run or
  restarts a terminated one; a `lost` owner is reported and only ever cancelled.
- **Start a run** — `start_unsupported`. Starting hosts the run in a Herdr pane,
  which the package does not export. Use `woof run start`.

### Serving the bundle

The request path is decoded exactly once, and that one decoded value decides
both where the file is looked up and whether the path names a file at all —
classifying the still-encoded path would let `/assets/missing%2ejs` look
extensionless and take the SPA fallback while `/assets/missing.js` is a 404. A
path that cannot be decoded is a 404, not a client-side route.

A path with no extension falls back to `index.html`; a missing path that names a
file — a stale hashed asset after a rebuild — is `404 asset_not_found`, because
answering it with HTML surfaces in the browser as a MIME error instead of a miss.

Every path is resolved, realpath'd and then checked to still be under the
realpath'd bundle root, so neither `..`, an encoded separator, nor a symlink
planted inside the bundle can leave it. `index.html` goes through the same check
as any asset: an index that resolves outside the bundle is reported as
`ui_bundle_missing`, exactly as an absent one is, rather than being the one file
that escapes.

## Security model

Binding to loopback is not by itself a defence. Vite's CVE-2025-24010 is the
precedent: a page in the operator's own browser reached a loopback-only dev
server through DNS rebinding, because the `Host` header was never validated. The
attacker's page, not the attacker's machine, is the reachability.

1. **Bind `127.0.0.1` by default.**
2. **Parse and validate `Host` on every request.** The header must match
   `^(\[ipv6\]|name)(:port)?$` after lower-casing, with no trailing dot;
   anything else is `400 host_invalid`. The parsed host must then be one of the
   loopback names, the bound address, or a name given with `--allow-host` —
   otherwise `403 host_not_allowed`. Junk after the host is a parse failure, not
   a port, so no guarantee here rests on what a lenient parser ignored.
3. **Require this server's own `Origin` on every mutating request.** The
   request's origin is built from its already-allowlisted `Host`
   (`http://<Host>`), and the `Origin` header must equal it exactly — scheme,
   host and port. Another port on the same machine is a different origin. A
   missing `Origin` and `Origin: null` are both refused on a POST. A
   mismatching `Origin` on a read is refused too. This is the CSRF defence for
   a server with no accounts and no cookies.
4. **`--allow-origin <origin>` (repeatable) is the only way to widen that.** It
   takes a whole origin, such as `http://127.0.0.1:5173`, and admits exactly
   that one. Nothing is allowed by default.
5. **Cancel requires `content-type: application/json`.** Anything else is
   `415 content_type_unsupported`. A JSON body is not a
   [simple request](https://developer.mozilla.org/docs/Web/HTTP/CORS#simple_requests),
   so a cross-origin attempt must preflight, and this server answers no
   preflight.
6. **Refuse a non-loopback `--host` without `--token`, and refuse a `--token`
   shorter than 16 characters.** Host and Origin checks do not authenticate
   whoever can reach the port. There is no generated default: the operator
   supplies one, e.g. `openssl rand -hex 16`.
7. **The token guards `/api/*` only.** The static bundle is public build output
   with no run data, and a `<script src>` subresource inherits neither a query
   string nor an `Authorization` header — gating it would load the page and
   nothing else. On the API the token is accepted as `Authorization: Bearer`
   and as `?token=`; the query form exists because `EventSource` cannot set
   request headers, and the SPA uses it only for the event stream.
8. **The token is printed in the URL fragment**, `http://host:port/#token=…`,
   never the query. A fragment is not sent to the server, so it stays out of
   access logs, proxies and `Referer` headers. The SPA reads it once at startup,
   keeps it in `sessionStorage` for that tab, and removes it from the address
   bar. A 401 renders as a plain "token missing or wrong" state.
9. **Bounded requests.** A mutating body is at most 1 KiB and must arrive within
   5 seconds; at most 64 event streams are held open.

There is no login, no session and no cookie. There is deliberately **no rate
limiting and no lockout** on a wrong token: this is a loopback tool for one
operator, and a lockout on a local port is a way to lock yourself out. The
token comparison is constant-time after a length check, so only the token's
length can leak from it.

**Reaching it from a phone.** `http://<LAN-IP>:4317` is not a secure context, so
notifications and service workers do not work there at all, whatever else is
configured. The supported path is an HTTPS origin in front of the server —
Tailscale Serve gives one with a real certificate. That needs three flags, not
two: `--token`, `--allow-host <name>.ts.net` for the `Host` the proxy forwards,
**and `--allow-origin https://<name>.ts.net`**, because the browser's origin is
`https://…` while this server's own origin is `http://…` and rule 3 compares the
scheme. Without it reads work and cancel is refused. None of this is automated
here.

## The interface

`ui/` is a Vite + React 19 + TypeScript app styled with Tailwind v4 and shadcn
components. Its dependencies live in the **root** `package.json`
`devDependencies`, so there is one package and one lockfile and
`bun install --frozen-lockfile` needs no new step. `components.json` at the
repository root points the shadcn CLI at `ui/src`; the root `tsconfig.json`
carries a `paths` entry only so that CLI can resolve the `@/*` aliases.

Brand tokens are transcribed into `ui/src/index.css` and shadcn's token names
are mapped onto them, so the components render in Woof's palette with no edits
to any shadcn component. Dark is the default theme and `[data-theme="light"]`
overrides it; `index.html` applies the stored choice before first paint.

The design system's faces — Geist and Source Code Pro — are self-hosted through
the `@fontsource-variable/*` packages (devDependencies, upright axis only) and
bundled into `dist-ui/assets/` by Vite. No Google Fonts request is made, so the
dashboard renders identically with no network.

Views:

- **Run list** (`/`) — status, run, workflow, stage, owner and age. A card per
  run at phone width; the same rows as a table from `md` up. Runs that need the
  operator are named in a strip above the list.
- **Run detail** (`/runs/:runId`) — the run's header and outcome, the blocked
  banner with its required action, the cancel and (disabled) unsupported
  actions, each agent's role/kind/model/pane, stages with their visits and
  attempts, the gate decisions, and the live event timeline.

**Notifications** are the in-tab `Notification` API only, for the transitions
worth interrupting for: blocked, failed, exhausted, completed. Permission is
requested from the toggle's click, never on load. There is no service worker and
no Web Push.

## The development loop

```sh
# terminal 1: the API on :4317, with the Vite origin admitted for cancel
bun run build && node dist/cli.js ui --runs-dir ~/.woof/runs --no-open \
  --allow-origin http://127.0.0.1:5173
# terminal 2: Vite on :5173, /api proxied to :4317
bun run dev:ui
# the UI's own checks
bun run typecheck:ui && bun run build:ui
```

`--allow-origin` is needed because the browser's origin while developing is the
Vite server's, not this server's, and rule 3 compares the whole origin. Reads
work without it; cancel is refused with `origin_not_allowed`. Nothing admits
:5173 by default.

The flag must name the origin you actually open. `ui/vite.config.ts` binds
`127.0.0.1`, so Vite prints `http://127.0.0.1:5173` — but `http://localhost:5173`
is a different origin, and opening that one instead leaves reads working while
cancel quietly 403s. `--allow-origin` is repeatable if you want both.

Open the Vite URL while developing; open the `woof ui` URL to exercise the built
bundle. `bun run verify` runs `typecheck:ui` and `build:ui` alongside the CLI's
checks.

## Build and packaging

`build:ui` is deliberately separate from `build`. `bun run test` runs
`bun run build` first, so folding the SPA into `build` would rebuild the bundle
on every test run. Instead `build:ui` is called by `verify`, by
`prepublishOnly`, and by the CI `package` and release `pack` jobs.

The bundle is written to `dist-ui/`, never under `dist/`, because `build` starts
with `rm -rf dist`. `dist-ui/` is listed in `files`, so the npm tarball ships
it, and `scripts/smoke-package.ts` asserts the packed tarball contains it — a
bundle that builds locally and silently never ships is exactly the failure this
check exists to catch.

A checkout that has compiled only the CLI has no `dist-ui/`. That is reported:
`woof ui` prints the command to build it and any non-API request answers `503`
with the same message. The API keeps working. Nothing serves a blank page.

Woof's Web UI is not intended to replace Herdr's generic artifact and file
viewers; it keeps artifact references available for those integrations.

## Known gaps

- **No answering a blocked agent.** The engine has no such call. The UI shows
  the block and the required action, and the control is disabled with the reason
  attached.
- **No retry, resume or re-host.** Same reason. Persisted history does not imply
  crash resume.
- **No start form.** Starting a run needs a Herdr pane; `woof run start` does it.
- **No Web Push, no service worker, no PWA install.** Phone notifications need
  an HTTPS origin and, on iOS, a home-screen install first.
- **No artifact viewer.** The snapshot carries references, never bodies. Fetching
  an artifact on demand is not implemented.
- **No filtering, sorting or cross-project grouping** in the run list, though
  `GET /api/runs?project=<dir>` already filters server-side.
- **The list enriches every entry with a second snapshot read.** Fine for a
  local runs directory of this size; it is not a paging design.
- **The bundle is about 500 kB (165 kB gzipped)** and is not code-split; the
  self-hosted faces add about 190 kB of woff2 across their subsets, of which a
  browser downloads only the ranges it needs.
- **The phone layout was written to the `md` breakpoint but has only been
  confirmed on a desktop viewport.**
- **No browser test.** The UI's automated check is `typecheck:ui` plus
  `build:ui`; the server has real-process tests in
  `test/web-server.process.test.ts`.
- **A client-side route whose last segment contains a dot 404s on a refresh.**
  The SPA fallback keys on "no file extension", so `/runs/a.b` is treated as a
  missing asset. Run ids do not contain dots, so nothing hits it today.
- **The token is per tab.** It lives in `sessionStorage`, so a new window needs
  the printed URL again. There is no logout, because there is no session.
