#!/usr/bin/env bash
# Internal state engine. Agents use the five public E2E lifecycle scripts.
set -uo pipefail

DIR="$HOME/.cache/kilo-e2e-slots"
TOTAL=3
POLL=10
ACQUIRE_DEADLINE=2700
mkdir -p "$DIR" || { echo "cannot create slot state dir $DIR" >&2; exit 1; }
[ -w "$DIR" ] || { echo "slot state dir $DIR is not writable" >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 1; }

self_session() {
  [ -n "${TMUX_PANE:-}" ] || return 0
  tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null || true
}

session_live() {
  tmux has-session -t "=$1" 2>/dev/null
}

reap() {
  local now slot owner modified age
  now=$(date +%s)
  for slot in "$DIR"/slot-*; do
    [ -d "$slot" ] || continue
    owner=$(cat "$slot/owner" 2>/dev/null || true)
    if [ -n "$owner" ]; then
      if ! session_live "$owner"; then
        rm -rf "$slot"
        echo "reclaimed $(basename "$slot") from dead session $owner" >&2
      fi
      continue
    fi

    # mkdir wins the slot before acquire publishes its owner. Only clear an
    # ownerless directory once it is old enough to be an interrupted acquire.
    # GNU first: on GNU stat, `-f` means --file-system and exits 0 with mount
    # info, so a BSD-first probe never falls through. BSD stat rejects `-c`.
    modified=$(stat -c %Y "$slot" 2>/dev/null || stat -f %m "$slot" 2>/dev/null || echo "$now")
    age=$((now - modified))
    [ "$age" -gt 60 ] && rm -rf "$slot"
  done
}

case "${1:?internal usage: $0 acquire|release|status|_held}" in
  _held)
    owner=$(self_session)
    [ -n "$owner" ] || exit 1
    for slot in "$DIR"/slot-*; do
      [ -d "$slot" ] || continue
      [ "$(cat "$slot/owner" 2>/dev/null)" = "$owner" ] || continue
      echo "$slot"
      exit 0
    done
    exit 1
    ;;
  acquire)
    [ -z "${2:-}" ] || {
      echo "acquire takes no session name; run it inside the tmux session that owns the work" >&2
      exit 1
    }
    owner=$(self_session)
    [ -n "$owner" ] || {
      echo "not inside tmux; a live tmux session must own the slot" >&2
      exit 1
    }
    session_live "$owner" || {
      echo "tmux session '$owner' is not live" >&2
      exit 1
    }

    for slot in "$DIR"/slot-*; do
      [ -d "$slot" ] || continue
      [ "$(cat "$slot/owner" 2>/dev/null)" = "$owner" ] || continue
      echo "already holding $(basename "$slot")"
      exit 0
    done

    deadline=$(($(date +%s) + ACQUIRE_DEADLINE))
    while :; do
      reap
      for number in $(seq 1 "$TOTAL"); do
        slot="$DIR/slot-$number"
        if mkdir "$slot" 2>/dev/null; then
          # Resolve via this script's own location, never the caller's CWD:
          # invoked by absolute path from a sibling repository (WORKFLOW.md),
          # a bare rev-parse would record the sibling's root and break the
          # status report's UNACCOUNTED matching.
          worktree=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || pwd -P)
          if printf '%s' "$worktree" > "$slot/worktree" &&
             date -u +%Y-%m-%dT%H:%M:%SZ > "$slot/since" &&
             printf '%s' "$owner" > "$slot/owner"; then
            echo "acquired slot-$number"
            exit 0
          fi
          rm -rf "$slot"
          echo "failed to record slot ownership in $DIR" >&2
          exit 1
        fi
      done
      if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "no slot freed in ${ACQUIRE_DEADLINE}s; current holders:" >&2
        "$0" status >&2 || true
        exit 1
      fi
      echo "all $TOTAL E2E slots busy; retrying in ${POLL}s" >&2
      sleep "$POLL"
    done
    ;;
  release)
    [ -z "${2:-}" ] || { echo "release takes no arguments" >&2; exit 1; }
    owner=$(self_session)
    [ -n "$owner" ] || { echo "not inside tmux" >&2; exit 1; }
    found=0
    for slot in "$DIR"/slot-*; do
      [ -d "$slot" ] || continue
      [ "$(cat "$slot/owner" 2>/dev/null)" = "$owner" ] || continue
      name=$(basename "$slot")
      rm -rf "$slot"
      echo "released $name"
      found=1
    done
    [ "$found" -eq 1 ] || echo "no slot held by $owner"
    ;;
  status)
    [ -z "${2:-}" ] || { echo "status takes no arguments" >&2; exit 1; }
    reap
    held=0
    for slot in "$DIR"/slot-*; do
      [ -d "$slot" ] || continue
      owner=$(cat "$slot/owner" 2>/dev/null || echo '<acquiring>')
      since=$(cat "$slot/since" 2>/dev/null || echo '<pending>')
      worktree=$(cat "$slot/worktree" 2>/dev/null || echo '<unknown>')
      echo "$(basename "$slot"): $owner since $since [$worktree]"
      held=$((held + 1))
    done
    echo "$held/$TOTAL held"
    ;;
  *)
    echo "internal usage: $0 acquire|release|status|_held" >&2
    exit 1
    ;;
esac
