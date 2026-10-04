#!/bin/sh
# Hermetic checks for scripts/plugin-build.sh: verified download, checksum
# mismatch and missing release both fall back to a (stubbed) source build.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d /tmp/woof-plugin-build-test.XXXXXX)
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
test -x "$ROOT/bin/woof" && test -x "$ROOT/bin/woofd" || fail 'run make build first'
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

version=$(sh "$ROOT/scripts/version.sh")
case $(uname -s) in Darwin) os=darwin ;; *) os=linux ;; esac
case $(uname -m) in x86_64|amd64) arch=amd64 ;; *) arch=arm64 ;; esac
name="woof_${version}_${os}_${arch}"

# A release directory served over file://.
mkdir -p "$WORK/release/$name/bin"
cp "$ROOT/bin/woof" "$ROOT/bin/woofd" "$WORK/release/$name/bin/"
tar -C "$WORK/release" -czf "$WORK/release/$name.tar.gz" "$name"
(cd "$WORK/release" && sha "$name.tar.gz" > checksums.txt)

# A `make` stub records the source fallback without compiling.
mkdir -p "$WORK/stub"
cat > "$WORK/stub/make" <<'EOF'
#!/bin/sh
mkdir -p bin && printf 'source build\n' > bin/woof && printf 'source build\n' > bin/woofd
EOF
chmod 755 "$WORK/stub/make"

new_root() {
  rm -rf "$WORK/plugin"
  mkdir -p "$WORK/plugin/scripts"
  cp "$ROOT/herdr-plugin.toml" "$WORK/plugin/"
  cp "$ROOT/scripts/plugin-build.sh" "$ROOT/scripts/version.sh" "$WORK/plugin/scripts/"
}
run_build() { PATH="$WORK/stub:$PATH" WOOF_RELEASE_BASE_URL="$1" sh "$WORK/plugin/scripts/plugin-build.sh" 2>"$WORK/build.log"; }

new_root
run_build "file://$WORK/release" || { cat "$WORK/build.log" >&2; fail 'verified download failed'; }
cmp "$ROOT/bin/woof" "$WORK/plugin/bin/woof" || fail 'downloaded woof differs'
cmp "$ROOT/bin/woofd" "$WORK/plugin/bin/woofd" || fail 'downloaded woofd differs'
grep -q 'installed release' "$WORK/build.log" || fail 'download path not reported'

new_root
cp "$WORK/release/checksums.txt" "$WORK/checksums.good"
printf '%064d  %s\n' 0 "$name.tar.gz" > "$WORK/release/checksums.txt"
run_build "file://$WORK/release" || fail 'mismatch did not fall back'
grep -q 'checksum mismatch' "$WORK/build.log" || fail 'mismatch not reported'
test "$(cat "$WORK/plugin/bin/woof")" = 'source build' || fail 'mismatched archive was installed'
cp "$WORK/checksums.good" "$WORK/release/checksums.txt"

new_root
run_build "file://$WORK/missing" || fail 'missing release did not fall back'
grep -q 'no release checksums' "$WORK/build.log" || fail 'missing release not reported'
test "$(cat "$WORK/plugin/bin/woof")" = 'source build' || fail 'missing release did not build from source'

printf 'PASS: plugin build verified download/checksum mismatch/missing release fallback\n'
