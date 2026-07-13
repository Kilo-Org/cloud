#!/usr/bin/env bash
# One-shot login helper for the Kilo dev build on a simulator/emulator.
#
# Requests an email sign-in code, reads it from the local email outbox
# (dev/logs/emails/, written by the Next.js dev server), and verifies it —
# leaving the app signed in on Home. No-op if already signed in.
#
# Usage:
#   e2e/login.sh <device-udid> [email]
#
# Env overrides:
#   OUTBOX   outbox dir (default: <repo-root>/dev/logs/emails)
#
# Requires: maestro, perl. Run the backend + Metro first (see e2e/AGENTS.md).
set -euo pipefail

DEVICE="${1:?usage: login.sh <device-udid> [email]}"
EMAIL="${2:-e2e-mobile@example.com}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
OUTBOX="${OUTBOX:-$REPO_ROOT/dev/logs/emails}"

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

echo "==> requesting sign-in code for $EMAIL"
maestro --device "$DEVICE" test -e "EMAIL=$EMAIL" "$SCRIPT_DIR/flows/login-request-code.yaml"

# Wait for a newer outbox email than we had before (the send is async).
code=""
for _ in $(seq 1 10); do
  after="$(latest_email)"
  if [ -n "$after" ] && [ "$after" != "$before" ]; then
    code="$(perl -0777 -ne 'print $1 if /letter-spacing:\s*8px.*?>\s*(\d{6})\s*</s' "$after")"
    [ -n "$code" ] && break
  fi
  sleep 1
done

if [ -z "$code" ]; then
  echo "==> no new sign-in code; verifying existing session"
  maestro --device "$DEVICE" test "$SCRIPT_DIR/flows/login-assert-home.yaml"
  echo "==> already signed in"
  exit
fi

echo "==> verifying sign-in code"
maestro --device "$DEVICE" test -e "OTP=$code" "$SCRIPT_DIR/flows/login-verify-code.yaml"
echo "==> signed in"
