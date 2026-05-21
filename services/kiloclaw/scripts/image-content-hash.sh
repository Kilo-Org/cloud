#!/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"
MODE="hash"
DOCKERFILE="Dockerfile"
OPENCLAW_TARBALL=""

usage() {
  echo "Usage: $0 [--hash|--list] [--dockerfile <path>] [--openclaw-tarball <path>]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hash)
      MODE="hash"
      shift
      ;;
    --list)
      MODE="list"
      shift
      ;;
    --dockerfile)
      if [ "$#" -lt 2 ]; then
        usage
        exit 1
      fi
      DOCKERFILE="$2"
      shift 2
      ;;
    --openclaw-tarball)
      if [ "$#" -lt 2 ]; then
        usage
        exit 1
      fi
      OPENCLAW_TARBALL="$2"
      shift 2
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

case "$MODE" in
  hash|list) ;;
  *)
    usage
    exit 1
    ;;
esac

cd "$KILOCLAW_DIR"

case "$DOCKERFILE" in
  "$KILOCLAW_DIR"/*)
    DOCKERFILE="${DOCKERFILE#"$KILOCLAW_DIR"/}"
    ;;
esac

case "$OPENCLAW_TARBALL" in
  "")
    ;;
  "$KILOCLAW_DIR"/*)
    OPENCLAW_TARBALL="${OPENCLAW_TARBALL#"$KILOCLAW_DIR"/}"
    ;;
  /*)
    echo "OpenClaw tarball must be inside $KILOCLAW_DIR: $OPENCLAW_TARBALL" >&2
    exit 1
    ;;
esac

for path in "$DOCKERFILE" .dockerignore ../../pnpm-workspace.yaml ../../pnpm-lock.yaml ../../patches controller container plugins/kiloclaw-customizer plugins/kilo-chat plugins/kiloclaw-morning-briefing skills \
            openclaw-pairing-list.js openclaw-device-pairing-list.js; do
  if [ ! -e "$path" ]; then
    echo "Required image hash path not found: $path" >&2
    exit 1
  fi
done
if [ -n "$OPENCLAW_TARBALL" ] && [ ! -f "$OPENCLAW_TARBALL" ]; then
  echo "Required image hash path not found: $OPENCLAW_TARBALL" >&2
  exit 1
fi

list_image_inputs() {
  {
    find "$DOCKERFILE" .dockerignore ../../pnpm-workspace.yaml ../../pnpm-lock.yaml ../../patches controller container plugins/kiloclaw-customizer plugins/kilo-chat plugins/kiloclaw-morning-briefing skills \
         openclaw-pairing-list.js openclaw-device-pairing-list.js \
      \( -type d \( -name node_modules -o -path 'plugins/*/dist' \) -prune \) -o \
      -type f -print
    if [ -n "$OPENCLAW_TARBALL" ]; then
      printf '%s\n' "$OPENCLAW_TARBALL"
    fi
  } \
    | while IFS= read -r file; do
        case "$file" in
          plugins/*/*.tgz) ;;
          *) printf '%s\n' "$file" ;;
        esac
      done \
    | sort
}

run_sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

case "$MODE" in
  list)
    list_image_inputs
    ;;
  hash)
    list_image_inputs \
      | while IFS= read -r file; do
          run_sha "$file"
        done \
      | run_sha \
      | cut -d' ' -f1 \
      | cut -c1-12
    ;;
esac
