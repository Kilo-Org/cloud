#!/bin/sh
# Control-plane wrapper supervisor (spec §7 "Supervisor").
#
# Runs the control-plane wrapper and restarts it after a non-zero exit with
# 1 s to 30 s backoff, at most 5 times in 10 minutes. Exit code 0 ends the
# loop. If the loop gives up it exits non-zero, and the Sandbox DO's
# `starting` or `disconnected` timer stops the sandbox.
#
# This script is the runtime owner of the restart limit and window: it runs
# outside the bundle and cannot import `src/shared/control-plane-timers.ts`.
# Those two values are documented there (the `supervisor` group) for reference
# and must match here. The window scales with `CONTROL_PLANE_TIMER_DIVISOR`
# using the same semantics as the timers module (`max(1, round(600 s / d))`);
# the limit is a count and does not scale.
#
# Test-only knobs: `CONTROL_PLANE_WRAPPER_COMMAND` and the backoff overrides.
# The defaults are the spec values.

set -u

WRAPPER_COMMAND="${CONTROL_PLANE_WRAPPER_COMMAND:-exec bun run /usr/local/bin/kilocode-control-plane-wrapper.js}"

sanitize_ms() {
  case "$1" in
    '' | *[!0-9]*) printf '%s' "$2" ;;
    *) printf '%s' "$1" ;;
  esac
}

BACKOFF_MIN_MS="$(sanitize_ms "${CONTROL_PLANE_SUPERVISOR_BACKOFF_MIN_MS:-1000}" 1000)"
BACKOFF_MAX_MS="$(sanitize_ms "${CONTROL_PLANE_SUPERVISOR_BACKOFF_MAX_MS:-30000}" 30000)"
if [ "$BACKOFF_MAX_MS" -lt "$BACKOFF_MIN_MS" ]; then
  BACKOFF_MAX_MS="$BACKOFF_MIN_MS"
fi

DIVISOR="${CONTROL_PLANE_TIMER_DIVISOR:-1}"
case "$DIVISOR" in
  '' | *[!0-9]*) DIVISOR=1 ;;
esac
if [ "$DIVISOR" -lt 1 ]; then
  DIVISOR=1
fi
RESTART_LIMIT=5
RESTART_WINDOW_S=$(((600 + DIVISOR / 2) / DIVISOR))
if [ "$RESTART_WINDOW_S" -lt 1 ]; then
  RESTART_WINDOW_S=1
fi

# Native-only operational stderr. SDK and Vercel exec this script with the gate
# unset and must not gain these lines. The JSON carries closed numeric fields
# only; never an environment dump.
NATIVE_LOGS="${CONTROL_PLANE_NATIVE_LOGS:-}"
native_log() {
  if [ "$NATIVE_LOGS" = "1" ]; then
    printf '%s\n' "$1" >&2
  fi
}

child=""
restarts=""
restart_count=0

sleep_ms() {
  ms="$1"
  if [ "$ms" -le 0 ]; then
    return 0
  fi
  seconds=$((ms / 1000))
  remainder=$((ms % 1000))
  if [ "$remainder" -eq 0 ]; then
    sleep "$seconds"
  else
    sleep "$seconds.$(printf '%03d' "$remainder")"
  fi
}

backoff_ms() {
  attempt="$1"
  delay="$BACKOFF_MIN_MS"
  step=1
  while [ "$step" -lt "$attempt" ]; do
    delay=$((delay * 2))
    if [ "$delay" -ge "$BACKOFF_MAX_MS" ]; then
      delay="$BACKOFF_MAX_MS"
      break
    fi
    step=$((step + 1))
  done
  if [ "$delay" -gt "$BACKOFF_MAX_MS" ]; then
    delay="$BACKOFF_MAX_MS"
  fi
  printf '%s' "$delay"
}

prune_restarts() {
  now="$(date +%s)"
  kept=""
  count=0
  for timestamp in $restarts; do
    if [ "$((now - timestamp))" -lt "$RESTART_WINDOW_S" ]; then
      kept="$kept $timestamp"
      count=$((count + 1))
    fi
  done
  restarts="$kept"
  restart_count="$count"
}

forward_term() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  native_log '{"source":"control-plane-supervisor","event":"supervisor_exit","exitCode":0}'
  exit 0
}

trap forward_term TERM INT

native_log '{"source":"control-plane-supervisor","event":"supervisor_started"}'

while true; do
  sh -c "$WRAPPER_COMMAND" &
  child=$!
  wait "$child"
  code=$?
  child=""

  if [ "$code" -eq 0 ]; then
    native_log '{"source":"control-plane-supervisor","event":"supervisor_exit","exitCode":0}'
    exit 0
  fi

  prune_restarts
  if [ "$restart_count" -ge "$RESTART_LIMIT" ]; then
    native_log "{\"source\":\"control-plane-supervisor\",\"event\":\"restart_budget_exhausted\",\"exitCode\":$code,\"restartCount\":$restart_count}"
    exit "$code"
  fi
  restarts="$restarts $(date +%s)"
  native_log "{\"source\":\"control-plane-supervisor\",\"event\":\"wrapper_restart\",\"exitCode\":$code,\"restartCount\":$((restart_count + 1))}"

  # Reset the backoff ladder with the window: a crash after the pruned
  # restarts wait one minimum interval, not the capped maximum.
  attempt=$((restart_count + 1))
  sleep_ms "$(backoff_ms "$attempt")"
done
