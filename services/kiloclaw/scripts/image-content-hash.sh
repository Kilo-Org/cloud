#!/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"
MODE="hash"
DOCKERFILE="Dockerfile"

usage() {
  echo "Usage: $0 [--hash|--list] [--dockerfile <path>]" >&2
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

for path in "$DOCKERFILE" controller container plugins/kiloclaw-customizer plugins/kilo-chat plugins/kiloclaw-morning-briefing skills \
            openclaw-pairing-list.js openclaw-device-pairing-list.js; do
  if [ ! -e "$path" ]; then
    echo "Required image hash path not found: $path" >&2
    exit 1
  fi
done

list_image_inputs() {
  find "$DOCKERFILE" controller container plugins/kiloclaw-customizer plugins/kilo-chat plugins/kiloclaw-morning-briefing skills \
       openclaw-pairing-list.js openclaw-device-pairing-list.js \
    \( -type d \( -name node_modules -o -path 'plugins/*/dist' \) -prune \) -o \
    -type f -print \
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
