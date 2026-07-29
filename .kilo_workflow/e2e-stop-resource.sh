#!/usr/bin/env bash
# Stop one resource before the caller frees its E2E slot.
set -euo pipefail

resource=${1:?usage: $0 stack | ios | android | command <cmd> [args...]}
shift
case "$resource" in
  stack) exec pnpm dev:stop ;;
  ios) exec pnpm dev:mobile:simulator release-all ;;
  android)
    failed=0
    pnpm dev:mobile:android emulator-stop || failed=1
    pnpm dev:mobile:android release-all || failed=1
    exit "$failed"
    ;;
  command)
    [ "$#" -gt 0 ] || { echo "command requires a command to run" >&2; exit 1; }
    exec "$@"
    ;;
  *) echo "unknown resource '$resource'; expected stack, ios, android, or command" >&2; exit 1 ;;
esac
