#!/usr/bin/env bash
# Wait on a dispatched role agent's log and report the round's outcome, per
# .kilo_workflow/WORKFLOW.md. This replaces hand-rolled wait loops: exit codes
# lie (kilo runs die mid-stream and still exit 0), grepping a whole log for a
# sentinel false-passes when the agent quoted one, and a stalled run can sit
# forever without ever writing its marker.
#
#   await-role.sh <log>
#
# Completion is proven by the wrapper-owned `<log>.exit` file dispatch-role.sh
# writes — never by text in the log, which the agent also writes. The
# `<log>.meta` sidecar (role, mode, tmux target) picks the sentinel contract:
# an implementer ending with `No findings.` — or a final verifier ending with
# `REPRODUCED.` — is a crashed contract, not a pass. A missing or corrupt
# sidecar is VOID: every legitimate dispatch goes through dispatch-role.sh.
# A dead tmux target with no exit file is VOID immediately.
#
# Blocks up to TIMEOUT seconds (480 — safely under harness command
# timeouts), then reports. Re-invoke while it prints RUNNING. Prints exactly
# one line:
#
#   DONE <sentinel>   exit 0  round finished with a real verdict; act on it
#   VOID ...          exit 2  finished without a valid verdict — a crashed
#                             run, never a pass; discard and dispatch fresh
#   STALLED <sec>s    exit 3  no exit file and the log has been quiet past the
#                             stall threshold (default 1200s) — kill the tmux
#                             window/session, verify state, redispatch fresh
#   RUNNING           exit 4  still working; invoke again
#
# The sentinel is the log's last line. `STOPPED EARLY.` reports as DONE: not
# void, not success; re-dispatch with a continuation handoff. A quiet log is
# judged by mtime, so any tool output the agent produces (builds included)
# counts as liveness.
set -euo pipefail

LOG=${1:?usage: await-role.sh <log>}
# 8 minutes to produce a verdict; 20 minutes of log silence reads as STALLED.
# Tune by editing these two numbers — never by adding call-site options.
TIMEOUT=480
STALL=1200

ROLE=""
MODE=""
TMUX_TARGET=""
if [ -f "$LOG.meta" ]; then
  ROLE=$(sed -n 's/^role=//p' "$LOG.meta" | head -1)
  MODE=$(sed -n 's/^mode=//p' "$LOG.meta" | head -1)
  TMUX_TARGET=$(sed -n 's/^tmux=//p' "$LOG.meta" | head -1)
fi

# Zero-findings variants are normalized at the verdict layer because the
# strictness cost rerun rounds; the anchored exact match stays because it
# catches crashed runs.
case "$ROLE/$MODE" in
  plan-reviewer/* | impl-reviewer/*) SENTINELS='^(No findings\.|FINDINGS: [1-9][0-9]*|STOPPED EARLY\.)$' ;;
  implementer/*) SENTINELS='^(SLICE COMPLETE\.|STOPPED EARLY\.)$' ;;
  e2e-verifier/repro) SENTINELS='^(REPRODUCED\.|CANNOT REPRODUCE\.|VERIFICATION BLOCKED\.|STOPPED EARLY\.)$' ;;
  e2e-verifier/*) SENTINELS='^(VERIFICATION (PASSED|FAILED|BLOCKED)\.|STOPPED EARLY\.)$' ;;
  *)
    echo "VOID missing or corrupt $LOG.meta — dispatch through dispatch-role.sh; discard the round"
    exit 2
    ;;
esac

normalize_reviewer_sentinel() {
  case "$ROLE/$MODE" in
    plan-reviewer/* | impl-reviewer/*)
      case "$1" in
        "FINDINGS: 0" | "FINDINGS:0" | "FINDINGS: 0.") echo "No findings." ;;
        "No findings") echo "No findings." ;;
        *) echo "$1" ;;
      esac
      ;;
    *) echo "$1" ;;
  esac
}

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }
target_dead() {
  [ -n "$TMUX_TARGET" ] || return 1
  ! tmux list-panes -t "$TMUX_TARGET" >/dev/null 2>&1
}

START=$(date +%s)
while :; do
  NOW=$(date +%s)
  if [ -f "$LOG.exit" ]; then
    CODE=$(cat "$LOG.exit" 2>/dev/null || echo "?")
    SENTINEL=$({ tail -1 "$LOG" 2>/dev/null || true; } | sed 's/^EXITCODE=[0-9]*$//;s/[[:space:]]*$//')
    # The human-facing EXITCODE marker is the true last line; the sentinel is
    # the line above it. Tolerate either ordering in case the marker write
    # raced the exit-file write.
    if [ -z "$SENTINEL" ]; then
      SENTINEL=$({ tail -2 "$LOG" 2>/dev/null || true; } | head -1 | sed 's/[[:space:]]*$//')
    fi
    SENTINEL=$(normalize_reviewer_sentinel "$SENTINEL")
    if [[ "$SENTINEL" =~ $SENTINELS ]]; then
      echo "DONE $SENTINEL"
      exit 0
    fi
    echo "VOID exit=$CODE — no valid $ROLE${MODE:+/$MODE} sentinel; discard the round and dispatch a fresh session"
    exit 2
  fi
  if [ -f "$LOG" ]; then
    if target_dead; then
      # The pane is gone but the exit file never landed; give the final
      # writes a moment to flush, then re-check once before pronouncing.
      sleep 5
      [ -f "$LOG.exit" ] && continue
      echo "VOID tmux target $TMUX_TARGET is gone with no exit file — the run was killed; discard and dispatch fresh"
      exit 2
    fi
    AGE=$(( NOW - $(mtime "$LOG") ))
    if [ "$AGE" -gt "$STALL" ]; then
      echo "STALLED ${AGE}s quiet, no exit file — kill the round's tmux window/session, verify state on disk, redispatch fresh"
      exit 3
    fi
  elif target_dead || [ $(( NOW - START )) -gt 90 ]; then
    # The dispatch redirects into the log the moment kilo starts; a log still
    # missing means the window died before launching.
    echo "VOID no log at $LOG — the dispatch never started; check tmux and dispatch again"
    exit 2
  fi
  if [ $(( NOW - START )) -ge "$TIMEOUT" ]; then
    echo "RUNNING — no verdict after ${TIMEOUT}s; invoke again to keep waiting"
    exit 4
  fi
  sleep 5
done
