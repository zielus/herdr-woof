#!/bin/sh
# Build release archives for darwin/linux on amd64/arm64 into dist/.
# Each archive mirrors the repository layout so scripts/install.sh works from
# the extracted directory. Binaries are pure Go (CGO_ENABLED=0).
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
version=$(sh scripts/version.sh)
targets=${WOOF_DIST_TARGETS:-"darwin/amd64 darwin/arm64 linux/amd64 linux/arm64"}
sh scripts/licenses.sh --check
rm -rf dist
mkdir -p dist
for target in $targets; do
  os=${target%/*} arch=${target#*/}
  name="woof_${version}_${os}_${arch}"
  stage="dist/$name"
  mkdir -p "$stage/bin" "$stage/skill" "$stage/scripts"
  for cmd in woof woofd; do
    GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' \
      -o "$stage/bin/$cmd" "./cmd/$cmd"
  done
  cp LICENSE THIRD_PARTY_NOTICES.md README.md CHANGELOG.md config.example.yml "$stage/"
  cp -R third_party "$stage/third_party"
  cp skill/SKILL.md "$stage/skill/SKILL.md"
  cp scripts/install.sh "$stage/scripts/install.sh"
  tar -C dist -czf "dist/$name.tar.gz" "$name"
  rm -rf "$stage"
done
cd dist
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -- *.tar.gz > checksums.txt
else
  shasum -a 256 -- *.tar.gz > checksums.txt
fi
cat checksums.txt
