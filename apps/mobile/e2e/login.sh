#!/usr/bin/env bash
# One-shot login helper for the Kilo dev build on a simulator/emulator.
#
# Requests an email sign-in code, reads it from the local email outbox
# (dev/logs/emails/, written by the Next.js dev server), and verifies it —
# leaving the app signed in on Home.
#
# Usage:
#   e2e/login.sh <device-udid> [email]
#
# When no email is given, defaults to a per-worktree, per-platform address
# (e2e-mobile-<worktree-basename>-<ios|android>@example.com), so parallel
# platform shards and concurrent worktrees never share a backend user.
#
# Env overrides:
#   OUTBOX   outbox dir (default: <repo-root>/dev/logs/emails)
#
# Requires: maestro, perl. Run the backend + Metro first (see e2e/AGENTS.md).
set -euo pipefail

DEVICE="${1:?usage: login.sh <device-udid> [email]}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
OUTBOX="${OUTBOX:-$REPO_ROOT/dev/logs/emails}"

WORKTREE_SLUG="$(basename "$REPO_ROOT" | tr -cs 'a-zA-Z0-9' '-' | sed 's/^-*//;s/-*$//' | tr 'A-Z' 'a-z')"
case "$DEVICE" in
  emulator-*) PLATFORM=android ;;
  *) PLATFORM=ios ;;
esac
EMAIL="${2:-e2e-mobile-${WORKTREE_SLUG}-${PLATFORM}@example.com}"

if [ "${KILO_MAESTRO_LOCKED:-}" != "1" ]; then
  exec "$SCRIPT_DIR/maestro.sh" "$DEVICE" --exec "$0" "$@"
fi

# Newest sign-in-code email for EMAIL, or empty.
latest_email() {
  [ -d "$OUTBOX" ] || return 0
  local f newest=""
  shopt -s nullglob
  for f in "$OUTBOX"/*.html; do
    if grep -q "Intended recipient: $EMAIL" "$f" 2>/dev/null &&
      { [ -z "$newest" ] || [ "$f" -nt "$newest" ]; }; then
      newest="$f"
    fi
  done
  [ -n "$newest" ] && printf '%s\n' "$newest"
  return 0
}

# Two parallel logins with the same email invalidate each other's OTP: a
# second code request voids the first code, so the first verify 401s. Hold a
# email mutex from the outbox snapshot through code verification. OTP
# invalidation is keyed by normalized email, not worktree.
if command -v sha256sum >/dev/null; then
  EMAIL_KEY=$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]' | sha256sum | cut -d' ' -f1)
else
  EMAIL_KEY=$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]' | shasum -a 256 | cut -d' ' -f1)
fi
LOCK="${TMPDIR:-/tmp}/kilo-otp-locks/$EMAIL_KEY"
if [ "${KILO_OTP_LOCKED:-}" != "1" ]; then
  exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/dev/local/process-lock.ts" \
    --wait 1200 "$LOCK" -- env KILO_MAESTRO_LOCKED=1 KILO_OTP_LOCKED=1 "$0" "$@"
fi

"$SCRIPT_DIR/preflight.sh" "$DEVICE"

# Snapshot inside the lock: an email another login produced while we waited
# must count as "old", or we would read its already-consumed code.
before="$(latest_email)"

request_code() {
  "$SCRIPT_DIR/maestro.sh" "$DEVICE" test -e "EMAIL=$EMAIL" "$SCRIPT_DIR/flows/login-request-code.yaml"
}

# Say which half broke, so nobody reads Maestro's generic "could be a real
# regression" advice as a product-bug lead.
diagnose_request() {
  local now
  now="$(latest_email)"
  if [ -n "$now" ] && [ "$now" != "$before" ]; then
    echo "==> the backend DID email a code: the request worked, the app never reached the code screen" >&2
  else
    echo "==> no code email for $EMAIL in $OUTBOX: the app never reached POST /api/auth/native/otp," >&2
    echo "    so the submit press did not fire (preflight already proved the backend is up)" >&2
  fi
}

echo "==> signing out and requesting sign-in code for $EMAIL"
if ! request_code; then
  # One cold relaunch clears both known first-attempt failures: a half-started
  # dev client, and an email field left dirty by an earlier run.
  echo "==> retrying launch and sign-in request once after a cold relaunch"
  "$SCRIPT_DIR/maestro.sh" "$DEVICE" test "$SCRIPT_DIR/flows/open-app.yaml" || true
  request_code || { diagnose_request; exit 1; }
fi

# Wait for a newer outbox email than we had before (the send is async).
code=""
for _ in $(seq 1 120); do
  after="$(latest_email)"
  if [ -n "$after" ] && [ "$after" != "$before" ]; then
    code="$(perl -0777 -ne 'print $1 if /letter-spacing:\s*8px.*?>\s*(\d{6})\s*</s' "$after")"
    [ -n "$code" ] && break
  fi
  sleep 0.25
done

if [ -z "$code" ]; then
  echo "==> reached the code screen, but no new code email for $EMAIL landed in $OUTBOX within 30s" >&2
  exit 1
fi

echo "==> verifying sign-in code"
"$SCRIPT_DIR/maestro.sh" "$DEVICE" test -e "OTP=$code" "$SCRIPT_DIR/flows/login-verify-code.yaml"
echo "==> signed in"
