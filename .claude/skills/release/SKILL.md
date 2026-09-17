---
name: release
description: Cut and publish a herdr-woof release — the Changesets Version PR, the trusted-publishing npm release workflow, preflight checks, and the manual tag-and-publish fallback. Use when the operator wants to release a new version, publish to npm, or tag a version.
user-invocable: true
---

# Release

`herdr-woof` releases with [Changesets](https://changesets.dev) and publishes to
npm through `.github/workflows/release.yml` using npm trusted publishing (OIDC):
no npm token lives anywhere in this repository or its secrets. The workflow
runs on every push to `master`. The maintainer's one action in a normal release
is merging the PR "chore: version packages".

## Steps

1. **Check what is pending, from an up-to-date `master` checkout.**
   `git checkout master && git pull && bun x changeset status --verbose`.
   `changeset status` compares the checkout with the base branch (`master`), so
   only its output on `master` describes the release. With pending changesets
   it exits 0 and prints them under `Packages to be bumped:`, for example
   `- patch` / `- herdr-woof -> 0.1.3` / `- .changeset/<name>.md`. With none,
   `Packages to be bumped:` is empty: there is nothing to release. On a feature
   branch that changes the package without adding a changeset it prints "Some
   packages have been changed but no changesets were found" and exits 1; that
   is about the branch, not the release. On a branch,
   `bun x changeset status --since master --verbose` shows only the changesets
   that branch adds.
2. **Preflight (non-strict), optional.**
   `bun run release:preflight` — warnings and skips are fine here (for example
   `secrets: skip` when `gitleaks` is not installed locally).
3. **Review the Version PR.**
   `gh pr list --head changeset-release/master`. `release.yml`'s `version` job
   keeps this PR up to date after every merge that adds a changeset: it runs
   `bun run version`, which bumps `package.json`, syncs `herdr-plugin.toml` and
   `plugin/claude/.claude-plugin/plugin.json`
   (`scripts/release/sync-version.ts`), writes the `## x.y.z` section of
   `CHANGELOG.md` and deletes the consumed `.changeset/*.md` files. Read the
   version and the changelog section.
4. **Get CI to run on it.**
   With the default `GITHUB_TOKEN`, GitHub starts no workflows for that PR.
   Either the `CHANGESETS_TOKEN` secret is set (then CI runs normally), or close
   and reopen the PR. The required checks must be green before merging.
5. **Merge the Version PR — human gate, this starts the publish.**
   On the resulting push, `select-mode` finds no changesets and a version that
   is not on the registry, so `gate` runs `bun run verify` and
   `bun run release:preflight --only versions,changelog,private-strings,pack`,
   `pack` packs the tarball, and `publish` publishes it.
6. **Approve the `npm` environment, if required reviewers are configured —
   human gate.**
   GitHub pauses the `publish` job on the `npm` environment until an approver
   clicks through, if the repo settings require it.
7. **Verify the publish.**
   `npm view herdr-woof version` shows `<x.y.z>`, `git ls-remote --tags origin
v<x.y.z>` shows the tag, `gh release view v<x.y.z>` shows the release, and the
   npm package page shows a provenance badge.

## What never happens automatically

Merging the Version PR, flipping repository visibility and deleting stale
branches are human steps. Tagging, the GitHub release and the npm publish
follow automatically from that merge and from nothing else. No agent merges the
Version PR on its own.

## One-time operator setup

- On npmjs.com, on the `herdr-woof` package: **Settings → Trusted publisher →
  GitHub Actions**, with owner `zielus`, repository `herdr-woof`, workflow
  filename `release.yml`, environment `npm`. **The filename must match
  exactly** — renaming the workflow file breaks the trusted-publisher link,
  and there is no token fallback in `release.yml` when that happens.
- On GitHub, repo **Settings → Actions → General**: enable **Allow GitHub
  Actions to create and approve pull requests**, or the `version` job fails.
- On GitHub, repo **Settings → Environments → `npm`**: optionally add required
  reviewers, to get step 6's human gate.
- Optionally, a repository secret `CHANGESETS_TOKEN`: a fine-grained personal
  access token with contents and pull-requests write on this repository, so
  CI runs on the Version PR without a close and reopen.
- The repository must be **public** for npm to attach automatic provenance to
  the publish.

## Fallback: manual tag and publish

Only when the workflow cannot publish (for example the trusted publisher is
broken). The maintainer does this, never an agent:

1. Merge the Version PR as usual, so `master` carries the new version and its
   changelog section.
2. `git checkout master && git pull`, then
   `bun run release:preflight --strict` — every warning and skip is a failure,
   so `secrets` must run (`gitleaks` installed) and `links` must resolve.
3. `git tag -a v<x.y.z> -m "v<x.y.z>" && git push origin v<x.y.z>`.
4. `npm publish` from that clean checkout, with npm's browser 2FA
   (`prepublishOnly` builds `dist/`).
5. `gh release create v<x.y.z>` with the `## x.y.z` section of `CHANGELOG.md`
   as the notes.

The next `release.yml` run finds the version on the registry and publishes
nothing.

## Related

- `bun run changeset` — add a changeset (every PR that changes `src/`).
- `bun run version` — what the Version PR runs; do not commit its output by
  hand outside the fallback.
- `bun run release:preflight [--only <ids>] [--skip <ids>] [--strict]
[--tag <vX.Y.Z>] [--visibility public|private|auto]` — checks: `versions`,
  `changelog`, `private-strings`, `secrets`, `links`, `format`, `verify`,
  `pack`, in that order.
- `docs/decisions/release-process.md` for the rules and why they exist.
- `docs/decisions/architecture.md`'s Known limits (0.1.x) table for the
  design-level items a release does not address.
