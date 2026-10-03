#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
expected=$(cat .golangci-version)
if ! command -v golangci-lint >/dev/null 2>&1; then
  echo "Install golangci-lint v$expected: https://golangci-lint.run/docs/welcome/install/local/" >&2
  exit 1
fi
actual=$(golangci-lint version --short)
if [ "$actual" != "$expected" ]; then
  echo "Expected golangci-lint v$expected; found $actual. See README.md for installation." >&2
  exit 1
fi
case "${1:-run}" in
  run|fmt) exec golangci-lint "${1:-run}" ;;
  *) echo "Usage: $0 [run|fmt]" >&2; exit 2 ;;
esac
