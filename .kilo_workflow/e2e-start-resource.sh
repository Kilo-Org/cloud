#!/usr/bin/env bash
# Start one resource while the caller owns an E2E slot.
set -euo pipefail
HERE=$(dirname "$0")
"$HERE/.e2e-slot-state.sh" _held >/dev/null || {
  echo "take a slot first: $HERE/e2e-take-slot.sh" >&2
  exit 1
}

resource=${1:?usage: $0 stack [targets...] | ios [udid] | android <avd> [--gpu ...] | command <cmd> [args...]}
shift
# Run repo wrappers from this script's own repository, never the caller's
# CWD — invoked by absolute path from a sibling worktree, pnpm would
# otherwise start the wrong stack while the slot record names this one.
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
case "$resource" in
  stack) exec pnpm dev:start --no-attach --reuse-running "$@" ;;
  ios) exec pnpm dev:mobile:simulator claim "$@" ;;
  android) exec pnpm dev:mobile:android emulator-start "$@" ;;
  command)
    [ "$#" -gt 0 ] || { echo "command requires a command to run" >&2; exit 1; }
    exec "$@"
    ;;
  *) echo "unknown resource '$resource'; expected stack, ios, android, or command" >&2; exit 1 ;;
esac
