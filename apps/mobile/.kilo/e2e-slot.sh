#!/usr/bin/env bash
# Device/stack slot semaphore for parallel mobile workflows.
#
# Only work that needs a simulator, a local backend stack, or a native build is
# capped. Planning, implementation, review, and CI waits are unlimited.
#
#   e2e-slot.sh acquire <tmux-session>   # blocks until a slot is free, then holds it
#   e2e-slot.sh release <tmux-session>   # release as soon as the device phase ends
#   e2e-slot.sh status                   # who holds what, and for how long
#
# A slot is owned by a tmux session name. If that tmux session no longer exists
# the slot is stale and is reclaimed automatically — no heartbeats to maintain.
#
# State is machine-global on purpose: every worktree's copy of this script must
# contend for the same slots, so the state dir never lives next to the script.
set -uo pipefail

DIR="${E2E_SLOT_DIR:-$HOME/.cache/kilo-e2e-slots}"
TOTAL=${E2E_SLOTS:-3}
POLL=${E2E_POLL:-60}
mkdir -p "$DIR"

reap() {
  # If tmux cannot answer (missing binary, no server, socket error), liveness
  # cannot be judged — keep every slot rather than wipe live ones. Acquirers
  # always run inside tmux, so the server is up whenever reaping matters.
  alive=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 0
  for s in "$DIR"/slot-*; do
    [ -d "$s" ] || continue
    owner=$(cat "$s/owner" 2>/dev/null || echo)
    [ -n "$owner" ] || { rm -rf "$s"; continue; }
    printf '%s\n' "$alive" | grep -qxF -- "$owner" || rm -rf "$s"
  done
}

case "${1:?usage: acquire|release|status <tmux-session>}" in
  acquire)
    who=${2:?tmux session name required}
    # already holding one? idempotent.
    for s in "$DIR"/slot-*; do
      [ -d "$s" ] && [ "$(cat "$s/owner" 2>/dev/null)" = "$who" ] && { echo "already holding $(basename "$s")"; exit 0; }
    done
    while :; do
      reap
      for i in $(seq 1 "$TOTAL"); do
        if mkdir "$DIR/slot-$i" 2>/dev/null; then
          printf '%s' "$who" > "$DIR/slot-$i/owner"
          date -u +%Y-%m-%dT%H:%M:%SZ > "$DIR/slot-$i/since"
          echo "acquired slot-$i"
          exit 0
        fi
      done
      echo "all $TOTAL device slots busy; retrying in ${POLL}s: $(ls -1 "$DIR" 2>/dev/null | tr '\n' ' ')" >&2
      sleep "$POLL"
    done
    ;;
  release)
    who=${2:?tmux session name required}
    for s in "$DIR"/slot-*; do
      [ -d "$s" ] && [ "$(cat "$s/owner" 2>/dev/null)" = "$who" ] && rm -rf "$s" && echo "released $(basename "$s")"
    done
    exit 0
    ;;
  status)
    reap
    n=0
    for s in "$DIR"/slot-*; do
      [ -d "$s" ] || continue
      n=$((n + 1))
      echo "$(basename "$s"): $(cat "$s/owner" 2>/dev/null) since $(cat "$s/since" 2>/dev/null)"
    done
    echo "$n/$TOTAL held"
    ;;
  *) echo "usage: $0 acquire|release|status <tmux-session>" >&2; exit 1 ;;
esac
