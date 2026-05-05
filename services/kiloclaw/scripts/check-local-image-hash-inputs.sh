#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"
HASH_SCRIPT="$SCRIPT_DIR/image-content-hash.sh"
LOCAL_TARBALL="$KILOCLAW_DIR/openclaw-build/openclaw-hash-input-check.tgz"

cleanup() {
  rm -f "$LOCAL_TARBALL"
}
trap cleanup EXIT

printf 'local openclaw package\n' > "$LOCAL_TARBALL"

INPUTS="$("$HASH_SCRIPT" --list --dockerfile Dockerfile.local --openclaw-tarball "$LOCAL_TARBALL")"

assert_contains() {
  local pattern="$1"
  if ! printf '%s\n' "$INPUTS" | grep -Eq "$pattern"; then
    echo "Expected local image hash inputs to include: $pattern" >&2
    exit 1
  fi
}

assert_not_contains() {
  local pattern="$1"
  if printf '%s\n' "$INPUTS" | grep -Eq "$pattern"; then
    echo "Expected local image hash inputs to exclude: $pattern" >&2
    printf '%s\n' "$INPUTS" | grep -E "$pattern" >&2
    exit 1
  fi
}

assert_contains '^Dockerfile.local$'
assert_contains '^\.dockerignore$'
assert_contains '^openclaw-build/openclaw-hash-input-check\.tgz$'
assert_contains '^controller/src/index.ts$'
assert_not_contains '^Dockerfile$'

echo "local image hash input list includes Dockerfile.local and selected OpenClaw tarball"
