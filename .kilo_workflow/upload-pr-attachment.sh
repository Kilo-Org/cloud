#!/usr/bin/env bash
# Upload one screenshot with the security-reviewed gh-image v1.2.0 binary only
# after verifying its release digest. See learnings/gh-image-unverified-release-binary.md.
set -euo pipefail

VERSION=v1.2.0
[ "$#" -eq 3 ] && [ "$2" = "--repo" ] || {
  echo "usage: $0 <screenshot> --repo <owner/repo>" >&2
  exit 1
}
SCREENSHOT=$1
REPO=$3
[ -f "$SCREENSHOT" ] && [ ! -L "$SCREENSHOT" ] || {
  echo "screenshot must be a regular, non-symlink file" >&2
  exit 1
}
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "repository must be owner/repo" >&2
  exit 1
}
case "$(file -b --mime-type "$SCREENSHOT")" in
  image/png | image/jpeg | image/gif | image/webp) ;;
  *) echo "only PNG, JPEG, GIF, or WebP screenshots are allowed" >&2; exit 1 ;;
esac
[ "$(wc -c < "$SCREENSHOT")" -le 10485760 ] || {
  echo "screenshot exceeds GitHub's 10 MB image limit" >&2
  exit 1
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET=darwin-arm64; EXPECTED=e0d7670f263dc495cca358b3676f049c51e3c1bafcab7836ba1d0557c099c15b ;;
  Darwin-x86_64) ASSET=darwin-amd64; EXPECTED=08353182ec9f1af8b445d192b538741fb7421a16e12e2645f2152ac859c0958a ;;
  Linux-aarch64 | Linux-arm64) ASSET=linux-arm64; EXPECTED=f36fd26e1920e217eb2bd1d5f7e0378c00f64214f3b011f5697d883943f0d1ee ;;
  Linux-x86_64) ASSET=linux-amd64; EXPECTED=0505f8c46d63bd603a445fdbfdd6be45e75a80778d97f1edf3580697fa6b7919 ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

unset GH_SESSION_TOKEN

KILO_CACHE_ROOT=${XDG_CACHE_HOME:-${HOME:?}/.cache}
BINARY="$KILO_CACHE_ROOT/kilo-workflow/gh-image/$VERSION/$ASSET"
checksum() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
if [ -f "$BINARY" ]; then
  ACTUAL=$(checksum "$BINARY")
else
  KILO_IMAGE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/kilo-gh-image.XXXXXX")
  trap 'rm -rf "$KILO_IMAGE_TMP"' EXIT
  gh release download "$VERSION" --repo drogers0/gh-image --pattern "$ASSET" --output "$KILO_IMAGE_TMP/$ASSET"
  ACTUAL=$(checksum "$KILO_IMAGE_TMP/$ASSET")
  [ "$ACTUAL" = "$EXPECTED" ] || { echo "gh-image checksum mismatch" >&2; exit 1; }
  mkdir -p "$(dirname "$BINARY")"
  install -m 0755 "$KILO_IMAGE_TMP/$ASSET" "$BINARY.tmp.$$"
  mv -f "$BINARY.tmp.$$" "$BINARY"
fi

[ "$ACTUAL" = "$EXPECTED" ] || { echo "cached gh-image checksum mismatch" >&2; rm -f "$BINARY"; exit 1; }
exec "$BINARY" "$SCREENSHOT" --repo "$REPO"
