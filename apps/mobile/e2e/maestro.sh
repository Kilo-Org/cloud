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
# PID recorded inside, released by the EXIT trap when maestro ends. A held
# lock with a live holder is polled every 2s; a dead holder's is reclaimed.
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

# Run maestro as a child (no exec): the EXIT trap then releases the lock the
# moment maestro ends, instead of leaving a dead-PID lock for the next waiter
# to reclaim — which PID reuse could make look live forever.
set +e
maestro --device "$DEVICE" "$@"
rc=$?
exit "$rc"
