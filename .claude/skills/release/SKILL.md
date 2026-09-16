---
name: release
description: Cut and publish a herdr-woof release — preflight checks, version bump, tag, and the trusted-publishing npm release workflow. Use when the operator wants to release a new version, publish to npm, or tag a version.
user-invocable: true
---

# Release

`herdr-woof` publishes to npm through `.github/workflows/release.yml` using npm
trusted publishing (OIDC): no npm token lives anywhere in this repository or its
secrets. The only thing that triggers a publish is pushing a `v*` tag.

## Steps

1. **Preflight (non-strict) on the working branch.**
   `bun run release:preflight` — fix anything that fails; warnings and skips
   are fine at this point (for example `secrets: skip` when `gitleaks` is not
   installed locally, or `links: warn` while the repo is private).
2. **Bump the version on a clean branch, after verify and review pass.**
   `bun run release:bump <x.y.z>` — refuses on a dirty tree, untracked files,
   a version that is not strictly greater, an existing `## [x.y.z]` section, or
   an empty `[Unreleased]`. It edits `package.json`, `herdr-plugin.toml` and
   `plugin/claude/.claude-plugin/plugin.json`, and moves `[Unreleased]`'s
   entries under a new `## [x.y.z] - YYYY-MM-DD` in `CHANGELOG.md`. It never
   commits or tags. Review the printed diff, then commit and push it yourself.
3. **Open a PR, wait for CI to go green, merge it.**
   Ordinary repo process — this phase does not change it.
4. **Pull master.**
   `git checkout master && git pull`.
5. **Preflight, strict, on master.**
   `bun run release:preflight --strict` — a human reads the summary. This is
   the last check before tagging; it turns every warning and skip into a
   failure, so `secrets` must actually run (`gitleaks` installed) and `links`
   must actually resolve.
6. **Tag the merge commit and push the tag — human gate, this triggers the
   publish workflow.**
   `git tag -a v<x.y.z> -m "v<x.y.z>" && git push origin v<x.y.z>`. Pushing the
   tag is the only thing that starts `.github/workflows/release.yml`.
7. **Approve the `npm` environment, if required reviewers are configured —
   human gate.**
   GitHub pauses the `publish` job on the `npm` environment until an approver
   clicks through, if the repo settings require it.
8. **Write release notes and create the GitHub release — human gate.**
   `bun run release:notes <x.y.z> --out notes.md && gh release create
   v<x.y.z> --notes-file notes.md`. `release:notes` only prints the
   `CHANGELOG.md` section body; it never creates the release itself.
9. **Verify the publish.**
   `npm view herdr-woof version` should show `<x.y.z>`, and the npm package
   page should show a provenance badge (automatic on a public repository
   publishing a public package).

## What never happens automatically

Tagging, publishing, creating the GitHub release, flipping repository
visibility, and deleting stale branches are all human steps. `release.yml`
only runs `verify` and `publish` after a tag push; nothing in this repository
creates a tag, a release, or an npm token on its own.

## One-time operator setup (before the first tag)

- On npmjs.com, on the `herdr-woof` package: **Settings → Trusted publisher →
  GitHub Actions**, with owner `zielus`, repository `herdr-woof`, workflow
  filename `release.yml`, environment `npm`. **The filename must match
  exactly** — renaming the workflow file breaks the trusted-publisher link,
  and there is no token fallback in `release.yml` when that happens.
- On GitHub, repo **Settings → Environments → `npm`**: optionally add required
  reviewers, to get step 7's human gate.
- The repository must be **public** for npm to attach automatic provenance to
  the publish.

## First publish — two paths, both unverified

npm's trusted-publisher documentation (read 2026-09-17) does not say whether a
trusted publisher can be configured before the package exists on npm at all.
Treat both of these as unverified until confirmed on npmjs.com:

- **(a) The package already exists on npm.** Configure the trusted publisher
  as above, then push a `v*` tag; `release.yml` publishes normally.
- **(b) It does not exist yet.** The operator (logged in, with 2FA or a
  short-lived granular token) runs one manual `npm publish` from a clean
  checkout to create the package, then follows path (a) for every release
  after that.

This skill's automation never publishes on its own; the operator decides
which path applies and does the manual publish themselves if (b) is needed.

## Related

- `bun run release:preflight [--only <ids>] [--skip <ids>] [--strict]
  [--tag <vX.Y.Z>]` — checks: `versions`, `changelog`, `private-strings`,
  `secrets`, `links`, `format`, `verify`, `pack`, in that order.
- `bun run release:bump <x.y.z> [--date YYYY-MM-DD]`
- `bun run release:notes [x.y.z] [--out <file>]`
- `docs/decisions/architecture.md`'s Known limits (0.1.x) table for the
  design-level items this release does not address.
