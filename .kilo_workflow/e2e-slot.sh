#!/usr/bin/env bash
# Device/stack slot semaphore for parallel workflows.
#
# A slot and a dev stack are the same resource: a slot is what entitles a
# worktree to run a stack, a device, or a native build. A stack must never
# outlive the slot that started it — five live stacks on a 14-core host push the
# load past the point where emulator boots and native builds time out, which
# reads as flaky devices rather than as over-subscription. Planning,
# implementation, review, and CI waits need neither, and are unlimited.
#
#   e2e-slot.sh acquire <tmux-session>   # blocks until a slot is free, then holds it
#   e2e-slot.sh release <tmux-session>   # frees the slot AND stops the worktree's stack
#   e2e-slot.sh status                   # who holds what, for how long, with stack coverage
#   e2e-slot.sh stacks [--reap]          # stacks with no slot; --reap stops them
#
# A slot is owned by a tmux session name and records the worktree that took it.
# If that tmux session no longer exists the slot is stale and is reclaimed
# automatically — no heartbeats to maintain.
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

# The worktree that owns this copy of the script — recorded at acquire time so
# release and reap know which stack belongs to the slot.
SELF_WORKTREE=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || echo)

# Section slugs carry a random run id (`<name>-$(openssl rand -hex 2)`, see
# WORKFLOW.md Ground Rules). Only those stacks are workflow-owned; a stack
# started by hand in a personal worktree is reported, never stopped.
is_section_slug() { [[ "$1" =~ -[0-9a-f]{4}$ ]]; }

# `\n` stays in the preserved set on purpose: without it `tr` rewrites the
# trailing newline `basename` emits into `_`, which `$(...)` can no longer
# strip, and every session name comes back with a spurious trailing underscore.
stack_session() { echo "kilo-dev-$(basename "$1" | tr -c 'A-Za-z0-9_-\n' '_')"; }

# Is any held slot entitled to this stack session? The recorded worktree is the
# real answer; the owner-name prefix is a fallback so slots written before
# worktrees were recorded never make a live stack look abandoned.
stack_is_covered() {
  # Every name here is local: this function loops over slots reassigning `wt`,
  # and its caller `stop_stack` still needs its own `wt` afterwards to know
  # which worktree to stop. Without `local` the caller's value is clobbered and
  # the wrong section's stack gets stopped.
  local sess=$1 s wt owner
  for s in "$DIR"/slot-*; do
    [ -d "$s" ] || continue
    wt=$(cat "$s/worktree" 2>/dev/null || echo)
    [ -n "$wt" ] && [ "$(stack_session "$wt")" = "$sess" ] && return 0
    owner=$(cat "$s/owner" 2>/dev/null || echo)
    case "$owner" in "${sess#kilo-dev-}"*) return 0 ;; esac
  done
  return 1
}

# Stop a worktree's stack, but only once no remaining slot covers it — a section
# can hold a second slot for a concurrent phase.
stop_stack() {
  local wt=$1 sess
  [ -n "$wt" ] && [ -d "$wt" ] || return 0
  sess=$(stack_session "$wt")
  stack_is_covered "$sess" && return 0
  tmux has-session -t "$sess" 2>/dev/null || return 0
  echo "stopping dev stack for $wt"
  (cd "$wt" && pnpm dev:stop)
}

reap() {
  # If tmux cannot answer (missing binary, no server, socket error), liveness
  # cannot be judged — keep every slot rather than wipe live ones. Acquirers
  # always run inside tmux, so the server is up whenever reaping matters.
  local alive now s owner mtime age wt
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
    if ! printf '%s\n' "$alive" | grep -qxF -- "$owner"; then
      # The owner is gone, so the slot AND the stack it entitled are both
      # reclaimable. Nothing is using a stack whose session died.
      wt=$(cat "$s/worktree" 2>/dev/null || echo)
      rm -rf "$s"
      stop_stack "$wt"
    fi
  done
}

# Stacks are named after their worktree, so a stack with no slot recording that
# worktree is uncovered — it outlived whatever entitled it to exist.
uncovered_stacks() {
  tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^kilo-dev-' | while read -r sess; do
    stack_is_covered "$sess" || echo "$sess"
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
          printf '%s' "$SELF_WORKTREE" > "$DIR/slot-$i/worktree"
          date -u +%Y-%m-%dT%H:%M:%SZ > "$DIR/slot-$i/since"
          echo "acquired slot-$i for ${SELF_WORKTREE:-unknown worktree}"
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
      [ -d "$s" ] || continue
      [ "$(cat "$s/owner" 2>/dev/null)" = "$who" ] || continue
      wt=$(cat "$s/worktree" 2>/dev/null || echo)
      rm -rf "$s"
      echo "released $(basename "$s")"
      # The stack goes with the slot. A later round acquires again and starts a
      # fresh one; leaving it up is what pushes the host past three stacks.
      stop_stack "$wt"
    done
    exit 0
    ;;
  status)
    reap
    n=0
    for s in "$DIR"/slot-*; do
      [ -d "$s" ] || continue
      n=$((n + 1))
      wt=$(cat "$s/worktree" 2>/dev/null || echo)
      # No recorded worktree means the slot predates this script — say so rather
      # than reporting a stack state that was never looked up.
      if [ -z "$wt" ]; then
        stack='worktree unrecorded, stack unknown'
      elif tmux has-session -t "$(stack_session "$wt")" 2>/dev/null; then
        stack="$wt stack=up"
      else
        stack="$wt stack=none"
      fi
      echo "$(basename "$s"): $(cat "$s/owner" 2>/dev/null) since $(cat "$s/since" 2>/dev/null) [$stack]"
    done
    echo "$n/$TOTAL held"
    uncovered=$(uncovered_stacks)
    if [ -n "$uncovered" ]; then
      echo "uncovered stacks (up with no slot — run '$0 stacks --reap'): $(printf '%s ' $uncovered)" >&2
    fi
    ;;
  stacks)
    reap
    uncovered=$(uncovered_stacks)
    [ -z "$uncovered" ] && { echo "every running dev stack is covered by a slot"; exit 0; }
    for sess in $uncovered; do
      slug=${sess#kilo-dev-}
      if [ "${2:-}" != "--reap" ]; then
        echo "$sess: up with no slot"
        continue
      fi
      if ! is_section_slug "$slug"; then
        echo "$sess: no section run id in the name — started by hand, leaving it alone"
        continue
      fi
      wt=$(git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r p; do
        [ "$(basename "$p")" = "$slug" ] && echo "$p"; done | head -1)
      [ -n "$wt" ] || { echo "$sess: no worktree on disk, leaving its session alone"; continue; }
      echo "stopping $sess ($wt)"
      (cd "$wt" && pnpm dev:stop)
    done
    ;;
  *) echo "usage: $0 acquire|release|status|stacks <tmux-session>" >&2; exit 1 ;;
esac
