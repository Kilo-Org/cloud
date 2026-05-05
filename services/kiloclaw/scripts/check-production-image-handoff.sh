#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/deploy-kiloclaw.yml"

SUMMARY_STEP="$(
  awk '
    /- name: Write dev \.dev\.vars summary/ { in_step = 1 }
    in_step && /^      - name:/ && !/- name: Write dev \.dev\.vars summary/ { exit }
    in_step { print }
  ' "$WORKFLOW"
)"

assert_contains() {
  local pattern="$1"
  local description="$2"

  if ! printf '%s\n' "$SUMMARY_STEP" | grep -Fq "$pattern"; then
    echo "Expected production image handoff to include $description" >&2
    exit 1
  fi
}

assert_contains 'echo "FLY_IMAGE_CONTENT_MODE=production"' 'FLY_IMAGE_CONTENT_MODE=production'
assert_contains 'echo "FLY_IMAGE_CONTENT_HASH=${CONTENT}"' 'FLY_IMAGE_CONTENT_HASH'

echo "production image handoff includes content mode and hash"
