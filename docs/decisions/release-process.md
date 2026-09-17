# Release process

Status: decided 2026-09-17 after the 0.1.1 and 0.1.2 releases. This records how a
version of `herdr-woof` gets from `master` to npm and why each step exists.
The executable form is the `release` skill in `.claude/skills/release/SKILL.md`.

## Versioning

Woof uses [SemVer](https://semver.org/) and is pre-1.0.

| Bump  | When                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| patch | Fixes and documentation; no new commands, fields, reasons or workflow ids.                                                                      |
| minor | New behaviour: commands, configuration fields, workflow definitions, journal or envelope changes. May break 0.x callers; the changelog says so. |
| major | 1.0: the first version whose public API, configuration and journal format are promised stable.                                                  |

The version is written in three files and must agree: `package.json`,
`herdr-plugin.toml`, `plugin/claude/.claude-plugin/plugin.json`.
`bun run check:version` enforces this in CI.

## Changelog as the gate

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every PR touching `src/` adds to `## [Unreleased]` (the `changelog` CI job
checks this). A release is therefore never written at release time: it is the
accumulated `[Unreleased]` section, and `release:bump` refuses to run when that
section is empty.

## Steps

1. **Bump on a branch.** `bun run release:bump <x.y.z>` edits the three version
   files and moves `[Unreleased]` under `## [x.y.z] - YYYY-MM-DD`. It refuses a
   dirty tree, a version that is not strictly greater, an existing section for
   that version, or an empty `[Unreleased]`. It never commits or tags.
2. **PR, CI green, merge.** The bump is an ordinary change. `master` is
   protected, so this is the only way it lands.
3. **Strict preflight on `master`.** `bun run release:preflight --strict` turns
   every warning and skip into a failure: secrets scan (gitleaks) must run,
   links must resolve, `npm pack --dry-run` must list `dist/cli.js`, the bin
   entry and the Claude plugin.
4. **Tag, human gate.** `git tag -a v<x.y.z> <merge-sha> -m "Woof <x.y.z>"` and
   `git push origin v<x.y.z>`. Pushing the tag is the only trigger of
   `.github/workflows/release.yml`. An agent never creates or pushes a tag.
5. **Publish, automated.** `release.yml` runs verify, builds, and publishes
   with npm trusted publishing (OIDC, provenance attached). There is no npm
   token in the repository or its secrets. If the tagged version is already on
   the registry the publish step is skipped and the run stays green.
6. **GitHub release.** `gh release create v<x.y.z> --notes-file <(bun run
release:notes <x.y.z>)` renders the changelog section as the release body.
7. **Confirm.** `npm view herdr-woof version` prints the new version.

## Fallback: manual publish

If trusted publishing is unavailable, `npm publish` from a clean `master`
checkout by the maintainer, with npm's browser 2FA. Tag first so the tag and the
published tarball share a commit. `release.yml` then skips the already-published
version.

## Why these rules

- **Bin path without `./`.** npm 11 silently dropped a `./dist/cli.js` bin at
  publish time; 0.1.1 was caught only because the first publish attempt bounced
  on 2FA. Preflight `pack` is being tightened to fail on any auto-correction of
  `package.json` (tracked for phase 8).
- **PR-only master.** Two direct pushes broke lint and format on `master`
  during phase 7. Protection makes the CI gate unavoidable.
- **Tag by a human.** Publishing is irreversible and public. Everything before
  the tag is reversible.
- **Serial verify.** The real-process timing tests flake above roughly 1.5×
  machine load; three concurrent verify runs produced false failures twice.
