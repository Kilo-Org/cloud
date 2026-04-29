#!/usr/bin/env bash
# Sync wire-contract zod schemas from packages/kilo-chat/src/ into the
# plugin's src/synced/ directory. The plugin is packed as a standalone npm
# tarball inside the kiloclaw docker image, so it cannot depend on the
# workspace package at build time.
#
# Run from the repo root after editing any of the source files.
# CI invokes this script with --check to verify files are in sync.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$REPO_ROOT/packages/kilo-chat/src"
DEST_DIR="$REPO_ROOT/services/kiloclaw/plugins/kilo-chat/src/synced"

FILES=(schemas.ts webhook-schemas.ts events.ts)

MODE="write"
if [ "${1:-}" = "--check" ]; then
  MODE="check"
fi

STATUS=0
for f in "${FILES[@]}"; do
  SRC="$SOURCE_DIR/$f"
  DST="$DEST_DIR/$f"
  if [ ! -f "$SRC" ]; then
    echo "error: source missing: $SRC" >&2
    exit 1
  fi
  if [ "$MODE" = "check" ]; then
    if ! diff -q "$SRC" "$DST" >/dev/null 2>&1; then
      echo "out of sync: $DST (source: $SRC)" >&2
      STATUS=1
    fi
  else
    cp "$SRC" "$DST"
    echo "synced $f"
  fi
done

if [ "$MODE" = "check" ] && [ "$STATUS" -ne 0 ]; then
  echo "" >&2
  echo "Run 'scripts/sync-plugin-shared.sh' to fix." >&2
  exit 1
fi
