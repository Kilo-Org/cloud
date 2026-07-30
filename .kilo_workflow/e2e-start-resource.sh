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
  stack)
    # Idempotent bindings (a fresh worktree's session-ingest rejects every
    # request until its Secrets Store binding exists), then the stack, then
    # migrations. Preflight probes readiness per device later; here we fail
    # fast when a requested service never comes up or the kiloclaw docker
    # bridge is dead.
    pnpm dev:env -y cloudflare-session-ingest
    pnpm dev:start --no-attach --reuse-running "$@"
    pnpm drizzle migrate
    STATUS="$(pnpm -s dev:status --json)"
    node - "$STATUS" "$@" <<'NODE'
const [statusJson, ...targets] = process.argv.slice(2);
const status = JSON.parse(statusJson);
const required = ['mobile', 'nextjs', 'cloudflare-session-ingest', ...targets];
const down = required.filter(name => status.services.find(s => s.name === name)?.status !== 'up');
if (down.length) {
  console.error(`e2e-start-resource: services not up: ${down.join(', ')}`);
  process.exit(1);
}
NODE
    case " $* " in
      *kiloclaw*) curl -sf --max-time 5 http://127.0.0.1:23750/v1.44/_ping >/dev/null || {
        echo "e2e-start-resource: kiloclaw docker bridge not answering on 23750" >&2
        exit 1
      } ;;
    esac
    ;;
  ios) exec pnpm dev:mobile:simulator claim "$@" ;;
  android) exec pnpm dev:mobile:android emulator-start "$@" ;;
  command)
    [ "$#" -gt 0 ] || { echo "command requires a command to run" >&2; exit 1; }
    exec "$@"
    ;;
  *) echo "unknown resource '$resource'; expected stack, ios, android, or command" >&2; exit 1 ;;
esac
