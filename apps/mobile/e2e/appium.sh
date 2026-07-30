#!/usr/bin/env bash
# Serialize Appium per device, manage one Appium server per device, and give
# flows a trustworthy exit code (a node process exits non-zero on any failed
# assertion — no report files to inspect). `--exec` holds the same device
# lock around a multi-command helper.
#
#   appium.sh <device> test [-e KEY=VALUE]... <flow.js>
#   appium.sh <device> hierarchy
#   appium.sh <device> server start|stop|status
#   appium.sh <device> --exec <command...>
#
# One-time machine setup is automatic: drivers install into APPIUM_HOME
# (default ~/.cache/kilo-appium) on first use.
set -euo pipefail

DEVICE="${1:?usage: appium.sh <device> <command> [args...]}"
shift
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
export APPIUM_HOME="${KILO_APPIUM_HOME:-$HOME/.cache/kilo-appium}"
APPIUM_BIN="$REPO_ROOT/node_modules/.bin/appium"
LOCK="${TMPDIR:-/tmp}/kilo-appium-locks/$DEVICE"

if [ "${KILO_APPIUM_LOCKED:-}" != "1" ]; then
  exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/dev/local/process-lock.ts" \
    --wait 1200 "$LOCK" -- env KILO_APPIUM_LOCKED=1 "$0" "$DEVICE" "$@"
fi

# shellcheck disable=SC1090
source <(node "$SCRIPT_DIR/wdio/ports.js" "$DEVICE")
STATE_DIR="${TMPDIR:-/tmp}/kilo-appium/$APPIUM_DEVICE_SLUG"
mkdir -p "$STATE_DIR" "$APPIUM_HOME"

ensure_drivers() {
  local want installed
  case "$DEVICE" in
    emulator-*) want=uiautomator2 ;;
    *) want=xcuitest ;;
  esac
  # appium logs to stderr; the list never reaches stdout.
  installed="$("$APPIUM_BIN" driver list --installed 2>&1 || true)"
  if ! grep -qw "$want" <<<"$installed"; then
    # Machine-global install: serialize so parallel first runs cannot race it.
    "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/dev/local/process-lock.ts" \
      --wait 1800 "${TMPDIR:-/tmp}/kilo-appium-locks/driver-install" -- \
      "$APPIUM_BIN" driver install "$want"
  fi
}

server_status() {
  curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:$APPIUM_PORT/status"
}

ensure_server() {
  if server_status; then return 0; fi
  ensure_drivers
  echo "appium.sh: starting appium server for $DEVICE on port $APPIUM_PORT" >&2
  nohup "$APPIUM_BIN" --port "$APPIUM_PORT" --log-level warn \
    >"$STATE_DIR/appium.log" 2>&1 &
  echo $! >"$STATE_DIR/appium.pid"
  for _ in $(seq 1 60); do
    if server_status; then return 0; fi
    if ! kill -0 "$(cat "$STATE_DIR/appium.pid")" 2>/dev/null; then
      echo "appium.sh: appium server died at launch; last log lines:" >&2
      tail -n 20 "$STATE_DIR/appium.log" >&2
      return 1
    fi
    sleep 1
  done
  echo "appium.sh: appium server did not answer /status within 60s ($STATE_DIR/appium.log)" >&2
  return 1
}

stop_server() {
  if [ -f "$STATE_DIR/appium.pid" ] && kill -0 "$(cat "$STATE_DIR/appium.pid")" 2>/dev/null; then
    kill "$(cat "$STATE_DIR/appium.pid")" || true
  fi
  rm -f "$STATE_DIR/appium.pid"
}

cmd="${1:-}"
case "$cmd" in
  --exec)
    shift
    [ $# -gt 0 ] || { echo "appium.sh: --exec needs a command" >&2; exit 1; }
    exec "$@"
    ;;
  server)
    case "${2:-}" in
      start) ensure_drivers && ensure_server ;;
      stop) stop_server ;;
      status) server_status && echo "up ($DEVICE, port $APPIUM_PORT)" || { echo "down"; exit 1; } ;;
      *) echo "usage: appium.sh <device> server start|stop|status" >&2; exit 1 ;;
    esac
    ;;
  test)
    shift
    ENV_ARGS=()
    FLOW=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -e) ENV_ARGS+=("$2"); shift 2 ;;
        *) FLOW="$1"; shift ;;
      esac
    done
    [ -n "$FLOW" ] || { echo "usage: appium.sh <device> test [-e K=V]... <flow.js>" >&2; exit 1; }
    ensure_server
    env DEVICE="$DEVICE" APPIUM_PORT="$APPIUM_PORT" "${ENV_ARGS[@]}" \
      node "$SCRIPT_DIR/wdio/run-flow.js" "$FLOW"
    ;;
  hierarchy)
    ensure_server
    env DEVICE="$DEVICE" APPIUM_PORT="$APPIUM_PORT" node "$SCRIPT_DIR/wdio/hierarchy.js"
    ;;
  *)
    echo "usage: appium.sh <device> test|hierarchy|server|--exec ..." >&2
    exit 1
    ;;
esac
