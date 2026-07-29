#!/usr/bin/env bash
# Monitor-mode helper: watch an interactive session (orchestrator, planner)
# and report its terminal state, per .kilo_workflow/WORKFLOW.md Monitor Mode.
# The scratch directory is the state machine — COMPLETE deletes it, BLOCKED
# leaves a final report in it — and a dead window is only a crash when
# neither of those happened.
#
#   await-interactive.sh <tmux-target> <scratch-dir> [--log <file>] [--timeout <sec>] [--quiet <sec>]
#
# Blocks up to --timeout (default 1500s, the ~25-minute monitor cadence),
# then reports. Prints exactly one line:
#
#   COMPLETED           exit 0  scratch gone — verify the PR is in gate state
#   BLOCKED <report>    exit 5  final-report.md present — relay it, leave scratch
#   DEAD                exit 2  target gone, scratch present, no report — a
#                               crash; relaunch fresh with a continuation handoff
#   QUIET <sec>s        exit 3  --log given and stagnant past --quiet (default
#                               1200s) with the target alive. NOT a verdict:
#                               read the pane first — a hands-on question or
#                               queued steers look exactly like this
#   RUNNING             exit 4  none of the above; invoke again
set -euo pipefail

TARGET=${1:?tmux target} SCRATCH=${2:?scratch dir}
shift 2
LOGFILE="" TIMEOUT=1500 QUIET=1200
while [ $# -gt 0 ]; do
  case $1 in
    --log) LOGFILE=${2:?}; shift 2 ;;
    --timeout) TIMEOUT=${2:?}; shift 2 ;;
    --quiet) QUIET=${2:?}; shift 2 ;;
    *) echo "await-interactive: unknown option $1" >&2; exit 1 ;;
  esac
done

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

START=$(date +%s)
while :; do
  if [ ! -d "$SCRATCH" ]; then
    echo "COMPLETED"
    exit 0
  fi
  if [ -f "$SCRATCH/final-report.md" ]; then
    echo "BLOCKED $SCRATCH/final-report.md"
    exit 5
  fi
  if ! tmux list-panes -t "$TARGET" >/dev/null 2>&1; then
    # Scratch present, no report, no session: give a just-finishing teardown
    # a moment, then re-check the two terminal states before calling it dead.
    sleep 5
    [ ! -d "$SCRATCH" ] && { echo "COMPLETED"; exit 0; }
    [ -f "$SCRATCH/final-report.md" ] && { echo "BLOCKED $SCRATCH/final-report.md"; exit 5; }
    echo "DEAD"
    exit 2
  fi
  if [ -n "$LOGFILE" ] && [ -f "$LOGFILE" ]; then
    AGE=$(( $(date +%s) - $(mtime "$LOGFILE") ))
    if [ "$AGE" -gt "$QUIET" ]; then
      echo "QUIET ${AGE}s — read the pane before acting; a user question or queued steer is not a wedge"
      exit 3
    fi
  fi
  if [ $(( $(date +%s) - START )) -ge "$TIMEOUT" ]; then
    echo "RUNNING"
    exit 4
  fi
  sleep 30
done
