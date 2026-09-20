# Contributing

Woof is pre-1.0 and developed by its maintainer with coding agents. The rules
below are what every change to this repository goes through, whoever or
whatever writes it.

## External contributions

Not yet. The repository is public so that people can read, install and report,
not so that they can open pull requests. Bug reports and questions are welcome
as issues. Pull requests from outside the maintainer's own agents are closed
until this section changes; there is no review-time promise.

The public API, the configuration files and the journal format can change
between 0.x minor versions. `CHANGELOG.md` records every such change.

## Every change goes through a pull request

`master` is protected: no direct pushes, linear history, no force pushes, and
these checks must be green at the PR's head before it merges: `typecheck`,
`lint`, `format`, `test`, `test (macOS)`, `package`, `changelog`. Zero
approvals are required by the protection rule; the maintainer (or the lead
agent acting for him) is the one who merges.

- Branch from `master`. Phase work uses `feat/<phase>`, everything else
  `chore/<topic>`, `fix/<topic>` or `docs/<topic>`.
- Squash-merge. The squash commit message is the PR title.
- Rebasing a phase branch onto a moved `master` is avoided; merge `master` in.
- Delete the branch after the merge unless a document cites one of its
  commits.

## Changesets

Releases are cut with [Changesets](https://changesets.dev). A pull request that
changes anything under `src/` runs `bun run changeset` and commits the
generated `.changeset/*.md` file; the `changelog` CI job fails otherwise.
Docs-only, CI-only and test-only changes may add one.

Pick `patch` for fixes and `minor` for new behaviour (see
[docs/decisions/release-process.md](docs/decisions/release-process.md) §
Versioning). The summary you write is what the user reads in `CHANGELOG.md` and
in the GitHub release: write it for the person upgrading, about what changed in
observable behaviour, not which file moved.

## Verification

`bun run verify` is the gate. It runs typecheck, lint, format check, the
version consistency check, the real-process test suite, and the package smoke
test. Run it before opening a PR and again at the final head of the branch.

Verify rounds run one at a time per machine. The suite contains real-process
timing tests that flake when several full runs share a host.

Some assertions and production test seams still use wall-clock time. Revisit
them when a specific CI race appears. Unit tests also import compiled `dist/`
in-process; real-process coverage exists, but public-import assertions should
move to that pattern as they change.

Report what was run and what it printed. A claim without command output is not
verification. See `AGENTS.md` § Verification for what counts as evidence.

## Phases

Larger work is delivered in phases, one phase per branch and PR. A phase merges
only when, at its final head: CI is green, a serial `bun run verify` passed, an
independent review by a different agent vendor than the builder passed, and the
docs for any shipped behaviour change are in the same PR. Phase records live
outside the repository; the PR description carries the summary and the
evidence pointers.

## Releases

Every merge to `master` runs `.github/workflows/release.yml`. While changesets
are pending it opens, or updates, the pull request "chore: version packages",
which bumps the version in `package.json`, `herdr-plugin.toml` and the Claude
Code `plugin.json` and writes the `CHANGELOG.md` section. Merging that pull
request publishes the package to npm through trusted publishing, tags
`vX.Y.Z` and creates the GitHub release. The maintainer's only action is
merging it. A manual tag and `npm publish` are the fallback only, taken through
the `release` skill (`.claude/skills/release/SKILL.md`). The process itself is
recorded in [docs/decisions/release-process.md](docs/decisions/release-process.md).

## Agents

`AGENTS.md` is the shared instruction file for every coding agent working in
this tree; `CLAUDE.md` imports it. Keep repository rules there, keep this file
about the contribution process.
