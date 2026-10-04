#!/bin/sh
# Installer acceptance uses only temporary destinations, never user settings.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d /tmp/woof-install-test.XXXXXX)
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
BIN="$WORK/bin with spaces"
SKILLS="$WORK/skills with spaces"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
install_woof() { WOOF_BIN_DIR="$BIN" WOOF_SKILLS_DIR="$SKILLS" sh "$ROOT/scripts/install.sh" "$@"; }

install_woof
test -x "$BIN/woof" && test -x "$BIN/woofd" || fail 'both binaries must be executable'
cmp "$ROOT/bin/woof" "$BIN/woof"
cmp "$ROOT/bin/woofd" "$BIN/woofd"
test ! -e "$SKILLS" || fail 'skills were installed without --skills'
"$BIN/woof" version --json | jq -e --arg v "$(sh "$ROOT/scripts/version.sh")" '.version == $v' >/dev/null
install_woof # repeated installs are idempotent
install_woof --skills
cmp "$ROOT/skill/SKILL.md" "$SKILLS/using-woof/SKILL.md"
printf 'user-owned addition\n' > "$SKILLS/using-woof/notes.md"
install_woof --uninstall --skills
test ! -e "$BIN/woof" && test ! -e "$BIN/woofd" || fail 'uninstall left owned binaries'
test ! -e "$SKILLS/using-woof/SKILL.md" || fail 'uninstall left owned skill'
test -f "$SKILLS/using-woof/notes.md" || fail 'uninstall deleted unrelated skill files'

mkdir -p "$BIN"
printf 'unrelated command\n' > "$BIN/woof"
if install_woof >"$WORK/conflict.log" 2>&1; then fail 'overwrote unrelated binary'; fi
test "$(cat "$BIN/woof")" = 'unrelated command' || fail 'changed conflicting binary'
test ! -e "$BIN/woofd" || fail 'partial install after conflict'
rm "$BIN/woof"
install_woof
printf 'changed after installation\n' >> "$BIN/woof"
if install_woof --uninstall >"$WORK/modified.log" 2>&1; then fail 'uninstall removed modified binary'; fi
test -f "$BIN/woof" && test -f "$BIN/woofd" || fail 'partial uninstall after modified binary'
# Restore the test file to its installed content and drain the installation.
cp "$ROOT/bin/woof" "$BIN/woof"
install_woof --uninstall
if install_woof --unknown >"$WORK/invalid.log" 2>&1; then fail 'accepted unknown installer flag'; fi
printf 'PASS: install/idempotence/opt-in skill/uninstall/conflict preservation\n'
