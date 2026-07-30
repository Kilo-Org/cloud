#!/usr/bin/env bash
# One-shot logout helper — signs the Kilo dev build out, ending on the login
# page. No-op if already signed out.
#
# Usage:
#   e2e/logout.sh <device-udid>
#
# See e2e/AGENTS.md ("Sign In and Out").
set -euo pipefail

DEVICE="${1:?usage: logout.sh <device-udid>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$DEVICE" in
  emulator-*) export KILO_E2E_PLATFORM=android ;;
esac

if [ "${KILO_APPIUM_LOCKED:-}" != "1" ]; then
  exec "$SCRIPT_DIR/appium.sh" "$DEVICE" --exec "$0" "$@"
fi
"$SCRIPT_DIR/preflight.sh" "$DEVICE"
"$SCRIPT_DIR/appium.sh" "$DEVICE" test "$SCRIPT_DIR/flows/logout.js"
