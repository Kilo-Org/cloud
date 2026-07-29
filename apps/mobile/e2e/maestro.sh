#!/usr/bin/env bash
# Serialize Maestro per device and turn its JUnit result into a trustworthy exit
# code. `--exec` holds the same device lock around a multi-command helper.
set -euo pipefail

DEVICE="${1:?usage: maestro.sh <device> <maestro-args...>}"
shift
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
LOCK="${TMPDIR:-/tmp}/kilo-maestro-locks/$DEVICE"

if [ "${KILO_MAESTRO_LOCKED:-}" != "1" ]; then
  exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/dev/local/process-lock.ts" \
    --wait 1200 "$LOCK" -- env KILO_MAESTRO_LOCKED=1 "$0" "$DEVICE" "$@"
fi

if [ "${1:-}" = "--exec" ]; then
  shift
  [ $# -gt 0 ] || { echo "maestro.sh: --exec needs a command" >&2; exit 1; }
  exec "$@"
fi

if [ "${1:-}" != "test" ]; then
  exec maestro --device "$DEVICE" "$@"
fi

REPORT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/kilo-maestro-report.XXXXXX")
trap 'rm -rf "$REPORT_DIR"' EXIT
REPORT="$REPORT_DIR/junit.xml"
set +e
maestro --device "$DEVICE" "$@" --format JUNIT --output "$REPORT"
rc=$?
set -e

if [ "$rc" -eq 0 ]; then
  if [ ! -s "$REPORT" ]; then
    echo "maestro.sh: test exited 0 without a JUnit report" >&2
    rc=1
  elif grep -Eq '<(failure|error)([ >])|(failures|errors)="[1-9][0-9]*"' "$REPORT"; then
    echo "maestro.sh: JUnit reports a failed assertion" >&2
    rc=1
  fi
fi
exit "$rc"
