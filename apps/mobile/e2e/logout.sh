#!/usr/bin/env bash
# One-shot logout helper — signs the Kilo dev build out, ending on the login
# page. No-op if already signed out.
#
# Usage:
#   e2e/logout.sh <device-udid>
#
# Requires: maestro. See e2e/AGENTS.md ("Sign In and Out").
set -euo pipefail

DEVICE="${1:?usage: logout.sh <device-udid>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/preflight.sh" "$DEVICE"
maestro --device "$DEVICE" test "$SCRIPT_DIR/flows/logout.yaml"
