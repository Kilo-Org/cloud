#!/usr/bin/env bash
# Start one resource while the caller owns an E2E slot.
set -euo pipefail
HERE=$(dirname "$0")
"$HERE/.e2e-slot-state.sh" _held >/dev/null || {
  echo "take a slot first: $HERE/e2e-take-slot.sh" >&2
  exit 1
}

resource=${1:?usage: $0 stack [targets...] | ios [udid] | android <avd> [--gpu ...] [--wait] | bundle <avd> [--gpu ...] | command <cmd> [args...]}
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
    # The reuse check rejects a live stack whose never-startable services
    # (stripe/tunnel without secrets) are down. The runner's own remedy:
    # retry once, then stop and start fresh — safe here because the slot
    # owner starts the stack before any verifier uses it.
    if ! pnpm dev:start --no-attach --reuse-running "$@"; then
      echo "e2e-start-resource: retrying stack start once" >&2
      if ! pnpm dev:start --no-attach --reuse-running "$@"; then
        echo "e2e-start-resource: stopping the partial stack and starting fresh" >&2
        pnpm dev:stop || true
        pnpm dev:start --no-attach "$@"
      fi
    fi
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
  android)
    # Idempotent per bundle: reuse a live own emulator, start otherwise.
    RECORD_DIR="${TMPDIR:-/tmp}/kilo-mobile-android-emulators"
    SLUG=$(basename "$PWD" | sed 's/[^A-Za-z0-9_-]/_/g')
    RECORD="$RECORD_DIR/$SLUG.json"
    if [ -f "$RECORD" ]; then
      SERIAL=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).serial)' "$RECORD")
      if pnpm -s dev:mobile:android adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | grep -q '^1'; then
        echo "reusing running emulator $SERIAL ($RECORD)" >&2
        cat "$RECORD"
        exit 0
      fi
      echo "recorded emulator not booted; starting fresh" >&2
      pnpm dev:mobile:android emulator-stop || true
    fi
    exec pnpm dev:mobile:android emulator-start "$@" --wait
    ;;
  bundle)
    # Whole E2E bundle at once: stack ∥ iOS chain ∥ Android chain, one log per
    # chain. The slowest chain sets the wall time, not the sum of the three.
    AVD=${1:?usage: $0 bundle <avd> [--gpu ...]}
    shift
    LOGD=$(mktemp -d "${TMPDIR:-/tmp}/kilo-bundle.XXXXXX")
    echo "bundle setup logs: $LOGD"
    (
      "$HERE/e2e-start-resource.sh" stack mobile cloud-agent-next kiloclaw event-service
    ) >"$LOGD/stack.log" 2>&1 &
    P_STACK=$!
    (
      CLAIM=$("$HERE/e2e-start-resource.sh" ios | tail -1) &&
        UDID=$(printf '%s' "$CLAIM" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).device.id)') &&
        pnpm dev:mobile:ios build "$UDID"
    ) >"$LOGD/ios.log" 2>&1 &
    P_IOS=$!
    (
      RECORD=$("$HERE/e2e-start-resource.sh" android "$AVD" "$@") &&
        SERIAL=$(printf '%s' "$RECORD" | grep -o '"serial": *"[^"]*"' | cut -d'"' -f4) &&
        [ -n "$SERIAL" ] &&
        pnpm -s dev:mobile:android claim "$SERIAL" >/dev/null &&
        pnpm dev:mobile:android build "$SERIAL"
    ) >"$LOGD/android.log" 2>&1 &
    P_ANDROID=$!
    FAILED=0
    for p in $P_STACK $P_IOS $P_ANDROID; do
      wait "$p" || FAILED=1
    done
    [ "$FAILED" -eq 0 ] || {
      echo "bundle setup failed — inspect $LOGD" >&2
      exit 1
    }
    echo "bundle ready (logs kept at $LOGD)"
    ;;
  command)
    [ "$#" -gt 0 ] || { echo "command requires a command to run" >&2; exit 1; }
    exec "$@"
    ;;
  *) echo "unknown resource '$resource'; expected stack, ios, android, or command" >&2; exit 1 ;;
esac
