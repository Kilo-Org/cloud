#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"
HASH_SCRIPT="$SCRIPT_DIR/image-content-hash.sh"
PACKED_ARTIFACT="$KILOCLAW_DIR/plugins/kilo-chat/hash-input-check.tgz"

cleanup() {
  rm -f "$PACKED_ARTIFACT"
}
trap cleanup EXIT

printf 'not an image input\n' > "$PACKED_ARTIFACT"

INPUTS="$("$HASH_SCRIPT" --list)"

assert_contains() {
  local pattern="$1"
  if ! printf '%s\n' "$INPUTS" | grep -Eq "$pattern"; then
    echo "Expected image hash inputs to include: $pattern" >&2
    exit 1
  fi
}

assert_not_contains() {
  local pattern="$1"
  if printf '%s\n' "$INPUTS" | grep -Eq "$pattern"; then
    echo "Expected image hash inputs to exclude: $pattern" >&2
    printf '%s\n' "$INPUTS" | grep -E "$pattern" >&2
    exit 1
  fi
}

assert_contains '^Dockerfile$'
assert_contains '^\.dockerignore$'
assert_contains '^plugins/kilo-chat/src/index.ts$'
assert_not_contains '(^|/)node_modules/'
assert_not_contains '^plugins/[^/]+/dist/'
assert_not_contains '^plugins/[^/]+/.*\.tgz$'

echo "image hash input list excludes generated plugin artifacts"
