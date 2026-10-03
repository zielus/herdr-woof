#!/bin/sh
# Explicit, local installation. Never edits config, registers a plugin, or starts
# a daemon. Replacing an executable uses rename (safe for running macOS binaries).
set -eu
woof_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
woof_bin_dir=${WOOF_BIN_DIR:-"$HOME/.local/bin"}
woof_skills_dir=${WOOF_SKILLS_DIR:-"$HOME/.agents/skills"}
woof_build=false
woof_skills=false
woof_uninstall=false
woof_stage=
usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--build] [--skills] [--uninstall]
                         [--bin-dir DIR] [--skills-dir DIR]

Install built bin/woof and bin/woofd into WOOF_BIN_DIR (default ~/.local/bin).
--build       Run make build before installing (requires Go and make).
--skills      Also copy the bundled using-woof skill into WOOF_SKILLS_DIR
              (default ~/.agents/skills). Skills are never copied implicitly.
--uninstall   Remove only files matching this installer's saved checksums.
              Stop the daemon first. Add --skills to remove the copied skill.

Conflicting or locally modified files are preserved and reported. No config,
daemon state, shell startup file, or Herdr plugin registration is changed.
EOF
}
fail() { printf 'woof install: %s\n' "$*" >&2; exit 1; }
while test "$#" -gt 0; do
  case "$1" in
    --build) woof_build=true ;;
    --skills) woof_skills=true ;;
    --uninstall) woof_uninstall=true ;;
    --bin-dir|--skills-dir)
      woof_option=$1
      shift
      test "$#" -gt 0 && test -n "$1" || fail "$woof_option requires a directory"
      if test "$woof_option" = --bin-dir; then woof_bin_dir=$1; else woof_skills_dir=$1; fi
      ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option $1; use --help" ;;
  esac
  shift
done
test -n "$woof_bin_dir" && test -n "$woof_skills_dir" || fail 'empty destination directory'
test "$woof_build" = false || test "$woof_uninstall" = false || fail '--build and --uninstall cannot be combined'
woof_receipts="$woof_bin_dir/.woof-install"
woof_skill_target="$woof_skills_dir/using-woof/SKILL.md"
woof_skill_receipt="$woof_skills_dir/using-woof/.woof-install-checksum"
checksum() {
  woof_sum=$(cksum "$1") || fail "cannot checksum $1"
  printf '%s\n' "$woof_sum" | awk '{ print $1 ":" $2 }'
}

# Preflight every selected target before changing any file.
check_install() {
  woof_source=$1 woof_target=$2 woof_receipt=$3
  if test -e "$woof_target" || test -L "$woof_target"; then
    test -f "$woof_target" && test ! -L "$woof_target" || fail "refusing nonregular target $woof_target"
    if cmp -s "$woof_source" "$woof_target"; then return; fi
    test -f "$woof_receipt" && test "$(checksum "$woof_target")" = "$(cat "$woof_receipt")" ||
      fail "preserving unrelated or modified file $woof_target"
  fi
}
check_remove() {
  woof_target=$1 woof_receipt=$2
  if test -e "$woof_target" || test -L "$woof_target"; then
    test -f "$woof_target" && test ! -L "$woof_target" && test -f "$woof_receipt" &&
      test "$(checksum "$woof_target")" = "$(cat "$woof_receipt")" ||
      fail "preserving unrelated or modified file $woof_target"
  fi
}
if test "$woof_uninstall" = true; then
  check_remove "$woof_bin_dir/woof" "$woof_receipts/woof"
  check_remove "$woof_bin_dir/woofd" "$woof_receipts/woofd"
  if test "$woof_skills" = true; then check_remove "$woof_skill_target" "$woof_skill_receipt"; fi
  rm -f "$woof_bin_dir/woof" "$woof_bin_dir/woofd" "$woof_receipts/woof" "$woof_receipts/woofd"
  rmdir "$woof_receipts" 2>/dev/null || true
  if test "$woof_skills" = true; then
    rm -f "$woof_skill_target" "$woof_skill_receipt"
    rmdir "$woof_skills_dir/using-woof" 2>/dev/null || true
  fi
  printf 'Removed matching Woof installation from %s. Config and state preserved.\n' "$woof_bin_dir"
  exit 0
fi
if test "$woof_build" = true; then make -C "$woof_root" build; fi
for woof_name in woof woofd; do
  test -f "$woof_root/bin/$woof_name" && test -x "$woof_root/bin/$woof_name" || fail "missing executable bin/$woof_name; run make build or use --build"
  check_install "$woof_root/bin/$woof_name" "$woof_bin_dir/$woof_name" "$woof_receipts/$woof_name"
done
if test "$woof_skills" = true; then check_install "$woof_root/skill/SKILL.md" "$woof_skill_target" "$woof_skill_receipt"; fi
trap 'test -z "$woof_stage" || rm -f "$woof_stage"' EXIT HUP INT TERM
install_file() {
  woof_source=$1 woof_target=$2 woof_receipt=$3 woof_mode=$4
  mkdir -p "$(dirname -- "$woof_target")" "$(dirname -- "$woof_receipt")"
  woof_stage=$(mktemp "$(dirname -- "$woof_target")/.woof.XXXXXX")
  cp "$woof_source" "$woof_stage"
  chmod "$woof_mode" "$woof_stage"
  mv -f "$woof_stage" "$woof_target"
  woof_stage=
  checksum "$woof_target" > "$woof_receipt"
}
install_file "$woof_root/bin/woof" "$woof_bin_dir/woof" "$woof_receipts/woof" 755
install_file "$woof_root/bin/woofd" "$woof_bin_dir/woofd" "$woof_receipts/woofd" 755
if test "$woof_skills" = true; then
  install_file "$woof_root/skill/SKILL.md" "$woof_skill_target" "$woof_skill_receipt" 644
  printf 'Installed usage skill at %s\n' "$woof_skill_target"
fi
printf 'Installed woof and woofd in %s. Add this directory to PATH.\n' "$woof_bin_dir"
