#!/bin/sh
# Herdr [[build]] step. Fast path: download the release archive matching the
# manifest version and this platform, verify its SHA-256 against the release
# checksums, and install bin/woof and bin/woofd by rename. On any miss (no
# release, no network, checksum mismatch, unsupported platform) build from
# source with Go instead. WOOF_RELEASE_BASE_URL overrides the release URL;
# WOOF_PLUGIN_BUILD=source skips the download.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
repo=zielus/herdr-woof
version=$(sh scripts/version.sh)
base_url=${WOOF_RELEASE_BASE_URL:-"https://github.com/$repo/releases/download/v$version"}
work=

have() { command -v "$1" >/dev/null 2>&1; }
cleanup() { test -z "$work" || rm -rf "$work"; }
trap cleanup EXIT HUP INT TERM

build_from_source() {
  if ! have go; then
    echo "woof plugin build: Go 1.26+ is required to build from source; install Go or publish release v$version" >&2
    exit 1
  fi
  echo "woof plugin build: building from source" >&2
  make build
}

fallback() {
  echo "woof plugin build: $1; building from source instead" >&2
  build_from_source
  exit 0
}

download() {
  if have curl; then curl -fsSL -o "$2" "$1"
  elif have wget; then wget -q -O "$2" "$1"
  else return 127
  fi
}

sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{ print tolower($1) }'
  elif have shasum; then shasum -a 256 "$1" | awk '{ print tolower($1) }'
  else return 127
  fi
}

test "${WOOF_PLUGIN_BUILD:-}" != source || { build_from_source; exit 0; }

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fallback "unsupported OS $(uname -s)" ;;
esac
case $(uname -m) in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fallback "unsupported architecture $(uname -m)" ;;
esac

name="woof_${version}_${os}_${arch}"
work=$(mktemp -d)
download "$base_url/checksums.txt" "$work/checksums.txt" 2>/dev/null || fallback "no release checksums for v$version"
download "$base_url/$name.tar.gz" "$work/$name.tar.gz" 2>/dev/null || fallback "no release archive $name.tar.gz"
want=$(awk -v f="$name.tar.gz" '$2 == f || $2 == ("*" f) { print tolower($1); exit }' "$work/checksums.txt")
test -n "$want" || fallback "checksums.txt has no entry for $name.tar.gz"
got=$(sha256_of "$work/$name.tar.gz") || fallback "no sha256 tool"
test "$got" = "$want" || fallback "checksum mismatch for $name.tar.gz"

mkdir "$work/x"
tar -xzf "$work/$name.tar.gz" -C "$work/x" || fallback "cannot extract $name.tar.gz"
for cmd in woof woofd; do
  test -f "$work/x/$name/bin/$cmd" || fallback "archive is missing bin/$cmd"
done
"$work/x/$name/bin/woof" version >/dev/null 2>&1 || fallback "downloaded woof does not run on this host"

mkdir -p bin
for cmd in woof woofd; do
  cp "$work/x/$name/bin/$cmd" "bin/.$cmd.$$"
  chmod 755 "bin/.$cmd.$$"
  mv -f "bin/.$cmd.$$" "bin/$cmd"
done
echo "woof plugin build: installed release v$version ($os/$arch)" >&2
