#!/usr/bin/env bash
# Device/stack slot semaphore for parallel workflows.
#
# Only work that needs a simulator, emulator, browser fleet, local backend
# stack, or native build is capped. Planning, implementation, review, and CI
# waits are unlimited.
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

# The state dir and slot count are the machine-global contract — no env
# overrides, or parallel pipelines split the semaphore and defeat the cap.
DIR="$HOME/.cache/kilo-e2e-slots"
TOTAL=3
POLL=60
mkdir -p "$DIR"

reap() {
  # If tmux cannot answer (missing binary, no server, socket error), liveness
  # cannot be judged — keep every slot rather than wipe live ones. Acquirers
  # always run inside tmux, so the server is up whenever reaping matters.
  alive=$(tmux list-sessions -F '#{session_name}' 2>/dev/null) || return 0
  now=$(date +%s)
  for s in "$DIR"/slot-*; do
    [ -d "$s" ] || continue
    owner=$(cat "$s/owner" 2>/dev/null || echo)
    if [ -z "$owner" ]; then
      # An ownerless slot may be mid-acquire (mkdir landed, owner write
      # hasn't) — only reap it once it is old enough to be a real orphan.
      # stat -f %m is BSD/macOS; stat -c %Y is GNU/Linux.
      mtime=$(stat -f %m "$s" 2>/dev/null || stat -c %Y "$s" 2>/dev/null || echo "$now")
      age=$(( now - mtime ))
      [ "$age" -gt 60 ] && rm -rf "$s"
      continue
    fi
    printf '%s\n' "$alive" | grep -qxF -- "$owner" || rm -rf "$s"
  done
}

case "${1:?usage: acquire|release|status <tmux-session>}" in
  acquire)
    who=${2:?tmux session name required}
    # Reject an owner that is not a live session — a window name, or a session
    # name misread from the untargeted `display-message -p '#S'`. Such a slot is
    # reapable the moment it is written, so it gets handed to a second workflow
    # while this one still drives a device, and the machine silently
    # over-subscribes. Skip the check only when tmux cannot answer at all.
    if alive=$(tmux list-sessions -F '#{session_name}' 2>/dev/null); then
      if ! printf '%s\n' "$alive" | grep -qxF -- "$who"; then
        echo "no live tmux session named '$who' — own the slot with your own session name, not a window name" >&2
        exit 1
      fi
    fi
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
