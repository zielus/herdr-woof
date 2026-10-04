#!/bin/sh
# Print the release version from herdr-plugin.toml. With --check [TAG], also
# require the CLI constant (and the tag, when given) to match it.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
manifest=$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/herdr-plugin.toml" | head -n 1)
test -n "$manifest" || { echo "version: missing from herdr-plugin.toml" >&2; exit 1; }
if test "${1:-}" != --check; then
  printf '%s\n' "$manifest"
  exit 0
fi
cli=$(sed -n 's/^const Version = "\([^"]*\)"/\1/p' "$ROOT/internal/cli/execute.go")
test "$cli" = "$manifest" || { echo "version: internal/cli Version $cli != herdr-plugin.toml $manifest" >&2; exit 1; }
if test -n "${2:-}"; then
  test "$2" = "v$manifest" || { echo "version: tag $2 != v$manifest" >&2; exit 1; }
fi
grep -Eq "^## $manifest( |$)" "$ROOT/CHANGELOG.md" || { echo "version: CHANGELOG.md has no '## $manifest' entry" >&2; exit 1; }
echo "version: $manifest consistent"
