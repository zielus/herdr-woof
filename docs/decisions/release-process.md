# Release process

Status: decided 2026-09-17 after the 0.1.1 and 0.1.2 releases; Changesets
adopted the same day. This records how a version of `herdr-woof` gets from
`master` to npm and why each step exists. The workflow is
`.github/workflows/release.yml`; the operator's view, including the manual
fallback, is the `release` skill in `.claude/skills/release/SKILL.md`.

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

Release notes are written by the pull request author, not at release time.
Every PR touching `src/` runs `bun run changeset` and commits the generated
`.changeset/*.md` file: the bump level (patch or minor, per the table above)
and a summary for the person upgrading. The `changelog` CI job fails a PR that
changes `src/` without one; the Changesets Version PR
(`changeset-release/master`) is exempt, because it consumes changesets.

`CHANGELOG.md` sections from 0.1.3 on are generated from those files as
`## x.y.z` with `### Patch Changes` / `### Minor Changes` bullets that link the
pull request. Sections up to 0.1.1 keep their Keep a Changelog heading
(`## [x.y.z] - YYYY-MM-DD`). The 0.1.2 section's heading is the bare `## 0.1.2`
(its date moved into the body) for two reasons: Changesets inserts a new release
above the first `## x.y.z` heading, or directly below the title when there is
none, which would have put 0.1.3 above the file's introduction; and the
changesets publish action takes the GitHub release body from the section whose
heading is exactly the version, falling back to the whole file.
`check:version` and `release:preflight` accept both heading forms, require a
non-empty section for `package.json`'s version, and require a date only in the
bracketed form.

## Steps

1. **Merge a PR with a changeset.** Any push to `master` runs `release.yml`.
   Its `select-mode` job reads `.changeset/`: pending changesets select
   `version`; none, with a `package.json` version that is not on the registry,
   select `publish`; otherwise nothing runs.
2. **Version PR, automated.** The `version` job runs `bun run version`
   (`changeset version`, then `scripts/release/sync-version.ts` copies the new
   version into `herdr-plugin.toml` and the Claude Code `plugin.json`, then
   prettier) and opens or updates the PR "chore: version packages" on
   `changeset-release/master`. More merges before it is merged update the same
   PR. With the default `GITHUB_TOKEN` that PR gets no CI runs; a
   `CHANGESETS_TOKEN` secret (fine-grained PAT, contents and pull-requests
   write) fixes that, or close and reopen the PR.
3. **Merge the Version PR, human gate.** This is the maintainer's only action
   in a normal release. Everything before it is reversible.
4. **Gate and pack, automated.** On the resulting push, `select-mode` selects
   `publish`. `gate` runs `bun run verify` and
   `bun run release:preflight --only versions,changelog,private-strings,pack`;
   `pack` builds and packs the tarball from the publish plan.
5. **Publish, automated.** `publish` runs in the `npm` environment (add
   required reviewers there for a second human gate), publishes the packed
   tarball with npm trusted publishing (OIDC, provenance attached), pushes the
   tag `vX.Y.Z` and creates the GitHub release from the changelog section.
   There is no npm token in the repository or its secrets. `id-token: write`
   is granted to this job only.
6. **Confirm.** `npm view herdr-woof version` prints the new version.

## Fallback: manual publish

If trusted publishing is unavailable, `npm publish` from a clean `master`
checkout by the maintainer, with npm's browser 2FA, after the Version PR has
merged. Tag first so the tag and the published tarball share a commit. The next
`release.yml` run finds the version on the registry and publishes nothing.

## Why these rules

- **Bin path without `./`.** npm 11 silently dropped a `./dist/cli.js` bin at
  publish time; 0.1.1 was caught only because the first publish attempt bounced
  on 2FA. Preflight `pack` is being tightened to fail on any auto-correction of
  `package.json` (tracked for phase 8).
- **PR-only master.** Two direct pushes broke lint and format on `master`
  during phase 7. Protection makes the CI gate unavoidable.
- **Merge by a human.** Publishing is irreversible and public. Merging the
  Version PR is the one human step before it; everything before that merge is
  reversible.
- **Changesets, adopted 2026-09-17, replaces the hand-rolled bump**
  (`release:bump`, `release:notes`, a human-pushed tag). Reasons: bump-by-merge
  is the ecosystem standard (pnpm, Turborepo, Radix); entries are written by
  the PR author when the change is fresh; no token lives in the repository.
- **Serial verify.** The real-process timing tests flake above roughly 1.5×
  machine load; three concurrent verify runs produced false failures twice.
