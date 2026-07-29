#!/usr/bin/env bash
# Device/stack slot semaphore for parallel workflows.
#
# A slot, a dev stack, and a claimed device are the same resource: a slot is
# what entitles a worktree to run a stack, a device, or a native build. Neither
# a stack nor a device may outlive the slot that started it — five live stacks
# on a 14-core host push the load past the point where emulator boots and native
# builds time out, which reads as flaky devices rather than as
# over-subscription, and a simulator left booted keeps burning CPU under every
# section that follows. Planning, implementation, review, and CI waits need
# neither, and are unlimited.
#
#   e2e-slot.sh acquire                  # blocks until a slot is free, then holds it
#   e2e-slot.sh release [tmux-session]   # frees the slot AND hands back the worktree's stack and devices
#   e2e-slot.sh status                   # who holds what, for how long, with stack coverage
#   e2e-slot.sh stacks [--reap]          # stacks with no slot; --reap stops them
#
# A slot is owned by a tmux session name and records the worktree that took it.
# If that tmux session no longer exists the slot is stale and is reclaimed
# automatically — no heartbeats to maintain.
#
# acquire/release resolve the CALLER'S OWN tmux session — through $TMUX_PANE,
# never the untargeted `display-message -p '#S'`, which answers with the
# server's most recently active session and hands your slot an owner that can
# die while you still drive a device. acquire accepts no name at all; release
# accepts one only so an operator can clean up after a holder that is already
# dead.
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
  # and its caller `release_worktree_resources` still needs its own `wt`
  # afterwards to know which worktree to tear down. Without `local` the caller's
  # value is clobbered and the wrong section's stack gets stopped.
  local sess=$1 s wt owner
  for s in "$DIR"/slot-*; do
    [ -d "$s" ] || continue
    # A slot mid-release no longer entitles its worktree to anything — without
    # this, a release would see its own still-present slot as coverage and
    # skip the teardown it exists to perform.
    [ -f "$s/releasing" ] && continue
    wt=$(cat "$s/worktree" 2>/dev/null || echo)
    [ -n "$wt" ] && [ "$(stack_session "$wt")" = "$sess" ] && return 0
    owner=$(cat "$s/owner" 2>/dev/null || echo)
    case "$owner" in "${sess#kilo-dev-}"*) return 0 ;; esac
  done
  return 1
}

# Hand back everything a slot entitled a worktree to hold — its dev stack and
# every simulator it claimed — but only once no remaining slot covers it: a
# section can hold a second slot for a concurrent phase.
release_worktree_resources() {
  local wt=$1 sess rc=0 c serial
  [ -n "$wt" ] && [ -d "$wt" ] || return 0
  sess=$(stack_session "$wt")
  stack_is_covered "$sess" && return 0
  if tmux has-session -t "$sess" 2>/dev/null; then
    echo "stopping dev stack for $wt"
    (cd "$wt" && pnpm dev:stop) || rc=1
  fi
  # Devices go back whether or not a stack is up — a round can drive a claimed
  # simulator without one. Doing it here rather than trusting the runbook's
  # per-UDID `release` is the whole point: an agent that ends its device phase
  # without releasing each simulator by hand used to leave them booted for the
  # rest of the day. `release-all` only touches this worktree's own claims, and
  # only powers off devices its own claims booted.
  echo "releasing simulators claimed by $wt"
  (cd "$wt" && pnpm dev:mobile:simulator release-all) || rc=1
  # Android claims are per-serial files; drop this worktree's so dead sections
  # never wedge a serial.
  for c in "${TMPDIR:-/tmp}/kilo-mobile-android-claims"/*.json; do
    [ -f "$c" ] || continue
    grep -qF "\"worktreeRoot\":\"$wt\"" "$c" 2>/dev/null || continue
    serial=$(basename "$c" .json)
    echo "releasing android claim $serial held by $wt"
    (cd "$wt" && pnpm dev:mobile:android release "$serial") || rc=1
  done
  # The runbook launches every emulator inside this worktree's dedicated tmux
  # session — the session name IS the boot provenance, so killing it powers
  # off exactly the emulators this worktree started and never a foreign one.
  local android_sess
  android_sess="kilo-e2e-android-$(basename "$wt")"
  if tmux has-session -t "$android_sess" 2>/dev/null; then
    echo "killing emulator session $android_sess"
    tmux kill-session -t "$android_sess" || rc=1
  fi
  return "$rc"
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
      # The owner is gone, so the slot and everything it entitled — stack and
      # claimed devices — are all reclaimable. Tear down BEFORE freeing the
      # slot (the `releasing` marker takes it out of coverage), so a new
      # acquirer can never run alongside the dead holder's still-live stack.
      wt=$(cat "$s/worktree" 2>/dev/null || echo)
      touch "$s/releasing"
      release_worktree_resources "$wt" || true
      rm -rf "$s"
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

# The caller's own tmux session, resolved through its pane. Empty when not in
# tmux — a process that cannot own a slot, because reclamation keys on the
# owning session's liveness.
self_session() {
  [ -n "${TMUX_PANE:-}" ] || return 0
  tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null || true
}

case "${1:?usage: acquire|release|status|stacks [tmux-session]}" in
  acquire)
    # No explicit owner, ever: a slot acquired under any session but the
    # caller's own gets reclaimed on the wrong lifetime (or never), which is
    # exactly the leak the self-resolution exists to prevent.
    [ -z "${2:-}" ] || {
      echo "acquire takes no session name — run it from the session that will own the slot; it resolves the name itself" >&2
      exit 1
    }
    who=$(self_session)
    [ -n "$who" ] || {
      echo "not inside a tmux session — a slot owner must be a live tmux session so a dead holder can be reclaimed; run from your own session (your dispatcher should have launched you in one)" >&2
      exit 1
    }
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
          # A partially written slot is worse than no slot: the reaper would
          # hand it to someone else while this caller drives a device.
          if printf '%s' "$who" > "$DIR/slot-$i/owner" &&
             printf '%s' "$SELF_WORKTREE" > "$DIR/slot-$i/worktree" &&
             date -u +%Y-%m-%dT%H:%M:%SZ > "$DIR/slot-$i/since"; then
            echo "acquired slot-$i for ${SELF_WORKTREE:-unknown worktree}"
            exit 0
          fi
          rm -rf "$DIR/slot-$i"
          echo "failed to record slot ownership in $DIR (disk full?)" >&2
          exit 1
        fi
      done
      echo "all $TOTAL device slots busy; retrying in ${POLL}s: $(ls -1 "$DIR" 2>/dev/null | tr '\n' ' ')" >&2
      sleep "$POLL"
    done
    ;;
  release)
    who=${2:-$(self_session)}
    [ -n "$who" ] || { echo "not inside tmux and no session name given" >&2; exit 1; }
    fail=0
    for s in "$DIR"/slot-*; do
      [ -d "$s" ] || continue
      [ "$(cat "$s/owner" 2>/dev/null)" = "$who" ] || continue
      wt=$(cat "$s/worktree" 2>/dev/null || echo)
      # Tear down first, free the slot last: the `releasing` marker takes this
      # slot out of coverage so the teardown runs, while the still-occupied
      # slot directory keeps a new acquirer from starting a stack alongside
      # the one being stopped. The stack and the claimed devices go with the
      # slot; a later round acquires, starts, and claims fresh.
      touch "$s/releasing"
      release_worktree_resources "$wt" || fail=1
      rm -rf "$s"
      echo "released $(basename "$s")"
    done
    [ "$fail" -eq 0 ] || echo "release: teardown reported errors above — verify with status and dev:status" >&2
    exit "$fail"
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
      echo "reaping $sess ($wt)"
      release_worktree_resources "$wt"
    done
    ;;
  *) echo "usage: $0 acquire|release|status|stacks [tmux-session]" >&2; exit 1 ;;
esac
