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
# When no email is given, defaults to a per-worktree-unique address
# (e2e-mobile-<worktree-basename>@example.com) so concurrent worktrees never
# share a backend user. It is stable within a worktree, so repeat logins reuse
# the same seeded account.
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
EMAIL="${2:-e2e-mobile-${WORKTREE_SLUG}@example.com}"

"$SCRIPT_DIR/preflight.sh" "$DEVICE"

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

before="$(latest_email)"

request_code() {
  maestro --device "$DEVICE" test -e "EMAIL=$EMAIL" "$SCRIPT_DIR/flows/login-request-code.yaml"
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
  maestro --device "$DEVICE" test "$SCRIPT_DIR/flows/open-app.yaml" || true
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
maestro --device "$DEVICE" test -e "OTP=$code" "$SCRIPT_DIR/flows/login-verify-code.yaml"
echo "==> signed in"
