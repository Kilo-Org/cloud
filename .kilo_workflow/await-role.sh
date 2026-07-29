#!/usr/bin/env bash
# Wait on a dispatched role agent's log and report the round's outcome, per
# .kilo_workflow/WORKFLOW.md. This replaces hand-rolled wait loops: exit codes
# lie (kilo runs die mid-stream and still exit 0), grepping a whole log for a
# sentinel false-passes when the agent quoted one, and a stalled run can sit
# forever without ever writing its EXITCODE marker.
#
#   await-role.sh <log> [--timeout <sec>] [--stall <sec>]
#
# Blocks up to --timeout (default 480s — safely under harness command
# timeouts), then reports. Re-invoke while it prints RUNNING. Prints exactly
# one line:
#
#   DONE <sentinel>   exit 0  round finished with a real verdict; act on it
#   VOID exit=<n>     exit 2  finished without a sentinel — a crashed run,
#                             never a pass; discard and dispatch fresh
#   STALLED <sec>s    exit 3  no EXITCODE and the log has been quiet past the
#                             stall threshold (default 1200s) — kill the tmux
#                             window/session, verify state, redispatch fresh
#   RUNNING           exit 4  still working; invoke again
#
# The sentinel is the line above the EXITCODE marker — the only place a
# verdict counts. `STOPPED EARLY.` reports as DONE: not void, not success;
# re-dispatch with a continuation handoff.
set -euo pipefail

LOG=${1:?usage: await-role.sh <log> [--timeout <sec>] [--stall <sec>]}
shift
TIMEOUT=480
STALL=1200
while [ $# -gt 0 ]; do
  case $1 in
    --timeout) TIMEOUT=${2:?}; shift 2 ;;
    --stall) STALL=${2:?}; shift 2 ;;
    *) echo "await-role: unknown option $1" >&2; exit 1 ;;
  esac
done

SENTINELS='^(No findings\.|FINDINGS: [0-9]+|STOPPED EARLY\.|SLICE COMPLETE\.|VERIFICATION (PASSED|FAILED|BLOCKED)\.|REPRODUCED\.|CANNOT REPRODUCE\.)$'

mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

START=$(date +%s)
while :; do
  NOW=$(date +%s)
  if [ -f "$LOG" ]; then
    LAST=$(tail -1 "$LOG" 2>/dev/null || true)
    if [[ "$LAST" =~ ^EXITCODE=([0-9]+) ]]; then
      CODE=${BASH_REMATCH[1]}
      # Strip trailing whitespace; roles must end their report with the bare
      # sentinel as the last line before the marker.
      SENTINEL=$(tail -2 "$LOG" | head -1 | sed 's/[[:space:]]*$//')
      if [[ "$SENTINEL" =~ $SENTINELS ]]; then
        echo "DONE $SENTINEL"
        exit 0
      fi
      echo "VOID exit=$CODE — no sentinel; discard the round and dispatch a fresh session"
      exit 2
    fi
    AGE=$(( NOW - $(mtime "$LOG") ))
    if [ "$AGE" -gt "$STALL" ]; then
      echo "STALLED ${AGE}s quiet, no EXITCODE — kill the round's tmux window/session, verify state on disk, redispatch fresh"
      exit 3
    fi
  elif [ $(( NOW - START )) -gt 90 ]; then
    # The dispatch redirects into the log the moment kilo starts; a log still
    # missing after a grace period means the window died before launching.
    echo "VOID no log at $LOG — the dispatch never started; check tmux and dispatch again"
    exit 2
  fi
  if [ $(( NOW - START )) -ge "$TIMEOUT" ]; then
    echo "RUNNING — no verdict after ${TIMEOUT}s; invoke again to keep waiting"
    exit 4
  fi
  sleep 15
done
