#!/usr/bin/env bash
# Monitor-mode helper: watch an interactive session (orchestrator, planner)
# and report its terminal state, per .kilo_workflow/WORKFLOW.md Monitor Mode.
# The scratch directory is the state machine — COMPLETE deletes it, BLOCKED
# leaves a final report in it — and a dead window is only a crash when
# neither of those happened.
#
#   await-interactive.sh <tmux-target> <scratch-dir> [--log <file>] \
#                      [--until-launched <name>]
#
# Blocks up to TIMEOUT seconds (default 600s, the ~10-minute monitor cadence),
# then reports. Prints exactly one line:
#
#   COMPLETED           exit 0  scratch gone — verify the PR is in gate state
#   BLOCKED <report>    exit 5  final-report.md present — relay it, leave scratch
#   LAUNCHED <name>     exit 6  --until-launched: the named tmux window or
#                               session exists (the planner's own launch should
#                               still be confirmed from its pane/log before the
#                               monitor is considered done)
#   DEAD                exit 2  target gone, scratch present, no report — a
#                               crash; relaunch fresh with a continuation handoff
#   QUIET <sec>s        exit 3  --log given and stagnant past the quiet budget (default
#                               1200s) with the target alive. NOT a verdict:
#                               read the pane first — a hands-on question or
#                               queued steers look exactly like this
#   RUNNING             exit 4  none of the above; invoke again
#
# QUIET fires across invocations via the log's mtime; in one call TIMEOUT now
# expires first, so do not lower QUIET when tightening TIMEOUT.
set -euo pipefail

TARGET=${1:?tmux target} SCRATCH=${2:?scratch dir}
shift 2
# 10 minutes per invocation; 20 quiet transcript minutes (QUIET=1200) reports QUIET.
# Tune by editing these two numbers — never by adding call-site options.
LOGFILE="" TIMEOUT=600 QUIET=1200 UNTIL_LAUNCHED=""
while [ $# -gt 0 ]; do
  case $1 in
    --log) LOGFILE=${2:?}; shift 2 ;;
    --until-launched) UNTIL_LAUNCHED=${2:?}; shift 2 ;;
    *) echo "await-interactive: unknown option $1" >&2; exit 1 ;;
  esac
done

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

launched() {
  [ -n "$UNTIL_LAUNCHED" ] || return 1
  tmux list-windows -a -F '#{window_name}' 2>/dev/null | grep -qx "$UNTIL_LAUNCHED" && return 0
  tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -qx "$UNTIL_LAUNCHED" && return 0
  return 1
}

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
  if launched; then
    echo "LAUNCHED $UNTIL_LAUNCHED"
    exit 6
  fi
  if ! tmux list-panes -t "$TARGET" >/dev/null 2>&1; then
    # Scratch present, no report, target gone: give a just-finishing teardown
    # a moment, then re-check terminal states and LAUNCHED before calling it dead
    # (planner may die in the same window as a successful orchestrator launch).
    sleep 5
    [ ! -d "$SCRATCH" ] && { echo "COMPLETED"; exit 0; }
    [ -f "$SCRATCH/final-report.md" ] && { echo "BLOCKED $SCRATCH/final-report.md"; exit 5; }
    if launched; then
      echo "LAUNCHED $UNTIL_LAUNCHED"
      exit 6
    fi
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
  sleep 10
done
