#!/usr/bin/env bash
# Serializes Maestro invocations per device. Maestro's device driver
# (XCUITest on iOS, uiautomator on Android) is single-tenant: two concurrent
# `maestro test`/`maestro hierarchy` processes against the same UDID/serial
# interleave taps and captures, and flows fail in ways that look like product
# defects. This wrapper takes a per-device mutex, then execs maestro.
#
# Usage: maestro.sh <device> <maestro-args...>
#   e.g. maestro.sh <udid> test -e EMAIL=x flows/login-request-code.yaml
#
# Lock: atomic mkdir under ${TMPDIR:-/tmp}/kilo-maestro-locks/<device>, holder
# PID recorded inside. exec preserves our PID, so the recorded PID is the live
# maestro process; when it exits, the next waiter reclaims via the dead-PID
# check. A held lock with a live holder is polled every 2s.
set -euo pipefail

DEVICE="${1:?usage: maestro.sh <device> <maestro-args...>}"
shift

LOCK="${TMPDIR:-/tmp}/kilo-maestro-locks/$DEVICE"
mkdir -p "$(dirname "$LOCK")"

while ! mkdir "$LOCK" 2>/dev/null; do
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    # Holder is dead: reclaim. mv is atomic, so two reclaimers cannot delete
    # a lock a third process just acquired.
    mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null && rm -rf "$LOCK.stale.$$"
    continue
  fi
  sleep 2
done
trap 'rm -rf "$LOCK"' EXIT
echo $$ >"$LOCK/pid"

# exec replaces this shell (dropping the trap) but keeps the PID, so the lock
# is held for exactly maestro's lifetime and reclaimed by the next waiter.
exec maestro --device "$DEVICE" "$@"
