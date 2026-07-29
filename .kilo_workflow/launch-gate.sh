#!/usr/bin/env bash
# Space machine-global kilo CLI launches so their shared SQLite stores do not
# race. The repository process lock supplies live-owner heartbeats, stale-lock
# recovery, and a bounded wait.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
GATE="$HOME/.cache/kilo-launch-gate"
LOCK_RUNNER="$ROOT/node_modules/.bin/tsx"
LOCK_SCRIPT="$ROOT/dev/local/process-lock.ts"

if [ "${1:-}" = "--locked" ]; then
  mkdir -p "$GATE"
  now=$(date +%s)
  last=$(cat "$GATE/last" 2>/dev/null || echo 0)
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  remaining=$(( 3 - (now - last) ))
  [ "$remaining" -le 3 ] || remaining=3
  [ "$remaining" -le 0 ] || sleep "$remaining"
  date +%s > "$GATE/last"
  exit 0
fi

[ -x "$LOCK_RUNNER" ] || {
  echo "launch-gate: missing $LOCK_RUNNER — prepare the cloud worktree before launching agents" >&2
  exit 1
}
exec "$LOCK_RUNNER" "$LOCK_SCRIPT" --wait 60 "$GATE/lock" -- "$0" --locked
