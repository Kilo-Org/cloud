#!/usr/bin/env bash
# Stop one resource before the caller frees its E2E slot.
set -euo pipefail

# Run from this script's own repository, never the caller's CWD — invoked by
# absolute path from a sibling worktree, pnpm would otherwise stop the wrong
# stack while the slot record names this one.
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

resource=${1:?usage: $0 stack | ios | android | command <cmd> [args...]}
shift
stop_appium_servers() {
  # Every claim record naming this worktree may have a live Appium server.
  local claims_dir json id
  for claims_dir in "${TMPDIR:-/tmp}/kilo-mobile-simulator-claims" "${TMPDIR:-/tmp}/kilo-mobile-android-claims"; do
    [ -d "$claims_dir" ] || continue
    for json in "$claims_dir"/*.json; do
      [ -f "$json" ] || continue
      node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(r.worktreeRoot===process.argv[2]?0:1)' "$json" "$PWD" 2>/dev/null || continue
      id=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(r.deviceId||r.serial||"")' "$json" 2>/dev/null || true)
      [ -n "$id" ] || continue
      apps/mobile/e2e/appium.sh "$id" server stop || \
        echo "e2e-stop-resource: appium server for $id still up — retry: apps/mobile/e2e/appium.sh $id server stop" >&2
    done
  done
}

case "$resource" in
  stack) exec pnpm dev:stop ;;
  ios)
    stop_appium_servers
    exec pnpm dev:mobile:simulator release-all
    ;;
  android)
    failed=0
    stop_appium_servers
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
