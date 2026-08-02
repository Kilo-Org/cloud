#!/usr/bin/env bash
# Serialize Appium per device, manage one Appium server per device, and give
# flows a trustworthy exit code (a node process exits non-zero on any failed
# assertion — no report files to inspect). `--exec` holds the same device
# lock around a multi-command helper.
#
#   appium.sh <device> test [-e KEY=VALUE]... <flow.js> [more-flows.js]
#   appium.sh <device> hierarchy [out.xml]   # writes the XML to a file and
#                                            # prints its path; never stdout
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
# The uiautomator2 driver locates the SDK through these; mirror the repo's
# resolution (dev/local/mobile-android.ts) so the agent's PATH never matters.
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ]; then
  for candidate in /opt/homebrew/share/android-commandlinetools "$HOME/Library/Android/sdk"; do
    if [ -d "$candidate" ]; then
      export ANDROID_HOME="$candidate" ANDROID_SDK_ROOT="$candidate"
      break
    fi
  done
fi
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
    # Re-check INSIDE the lock — the loser of the race would otherwise run a
    # second install and fail on "already installed".
    "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/dev/local/process-lock.ts" \
      --wait 1800 "${TMPDIR:-/tmp}/kilo-appium-locks/driver-install" -- \
      bash -c '"$1" driver list --installed 2>&1 | grep -qw "$2" || exec "$1" driver install "$2"' \
      _ "$APPIUM_BIN" "$want"
  fi
}

server_status() {
  curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:$APPIUM_PORT/status"
}

port_free() {
  ! nc -z 127.0.0.1 "$1" 2>/dev/null
}

ensure_server() {
  # Adopt only our own recorded server — and only while its recorded pid is
  # alive. A live pid with no /status is hung: kill it and start over. A dead
  # pid with a status answer is a hash-colliding sibling on this port:
  # adopting it would interleave taps across devices.
  if [ -f "$STATE_DIR/server.port" ] && [ -f "$STATE_DIR/appium.pid" ]; then
    APPIUM_PORT=$(cat "$STATE_DIR/server.port")
    RECORDED_PID=$(cat "$STATE_DIR/appium.pid")
    if kill -0 "$RECORDED_PID" 2>/dev/null; then
      if server_status; then
        # Adopt only when the recorded pid actually owns the listener — a
        # recycled pid plus a sibling's server on this port answers /status
        # while belonging to another device.
        # lsof exits 1 on no match; without || true, pipefail + set -e would
        # kill the script here instead of reaching the fallback below.
        LISTENER=$(lsof -ti "tcp:$APPIUM_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)
        if [ -n "$LISTENER" ] && [ "$LISTENER" = "$RECORDED_PID" ]; then
          return 0
        fi
        rm -f "$STATE_DIR/appium.pid" "$STATE_DIR/server.port"
      else
        stop_server
      fi
    fi
  fi
  ensure_drivers
  local base_port=$APPIUM_PORT attempt
  # Hash collisions and foreign listeners both resolve by bumping one block.
  for attempt in $(seq 0 49); do
    APPIUM_PORT=$((base_port + attempt * 10))
    port_free "$APPIUM_PORT" || continue
    if [ "$attempt" -gt 0 ]; then
      echo "appium.sh: bumping to port block $APPIUM_PORT" >&2
    fi
    echo "appium.sh: starting appium server for $DEVICE on port $APPIUM_PORT" >&2
    nohup "$APPIUM_BIN" --port "$APPIUM_PORT" --log-level warn \
      >"$STATE_DIR/appium.log" 2>&1 &
    echo $! >"$STATE_DIR/appium.pid"
    for _ in $(seq 1 60); do
      # Liveness first, then /status, then port OWNERSHIP: a sibling device's
      # server on this port also answers /status, and adopting it would let
      # one device's cleanup kill the other's server mid-flow.
      kill -0 "$(cat "$STATE_DIR/appium.pid")" 2>/dev/null || break
      if server_status; then
        LISTENER=$(lsof -ti "tcp:$APPIUM_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)
        if [ -n "$LISTENER" ] && [ "$LISTENER" != "$(cat "$STATE_DIR/appium.pid")" ]; then
          echo "appium.sh: port $APPIUM_PORT is owned by pid $LISTENER, not ours; bumping" >&2
          break
        fi
        echo "$APPIUM_PORT" >"$STATE_DIR/server.port"
        return 0
      fi
      sleep 1
    done
    stop_server
    echo "appium.sh: server attempt on port $APPIUM_PORT failed; last log lines:" >&2
    tail -n 10 "$STATE_DIR/appium.log" >&2
  done
  echo "appium.sh: no appium server came up after 50 port blocks ($STATE_DIR/appium.log)" >&2
  return 1
}

stop_server() {
  if [ -f "$STATE_DIR/appium.pid" ]; then
    PID=$(cat "$STATE_DIR/appium.pid")
    # Pids get recycled; only signal a process that is actually our appium.
    if kill -0 "$PID" 2>/dev/null && ps -o command= -p "$PID" 2>/dev/null | grep -q appium; then
      kill "$PID" 2>/dev/null || true
      # Dropping the state while the process lives would leave an untracked
      # listener squatting on the port; escalate before forgetting the pid,
      # and keep the state (fail) if even SIGKILL does not take.
      for _ in $(seq 1 10); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 1
      done
      kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
      for _ in 1 2 3; do
        kill -0 "$PID" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$PID" 2>/dev/null; then
        echo "appium.sh: pid $PID survived SIGKILL; keeping server state" >&2
        return 1
      fi
    fi
  fi
  rm -f "$STATE_DIR/appium.pid" "$STATE_DIR/server.port"
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
      status)
        [ -f "$STATE_DIR/server.port" ] && APPIUM_PORT=$(cat "$STATE_DIR/server.port")
        server_status && echo "up ($DEVICE, port $APPIUM_PORT)" || { echo "down"; exit 1; }
        ;;
      *) echo "usage: appium.sh <device> server start|stop|status" >&2; exit 1 ;;
    esac
    ;;
  test)
    shift
    ENV_ARGS=()
    FLOWS=()
    while [ $# -gt 0 ]; do
      case "$1" in
        -e) [ $# -ge 2 ] || { echo "appium.sh: -e needs a KEY=VALUE" >&2; exit 1; }
            ENV_ARGS+=("$2"); shift 2 ;;
        *) FLOWS+=("$1"); shift ;;
      esac
    done
    [ "${#FLOWS[@]}" -gt 0 ] || { echo "usage: appium.sh <device> test [-e K=V]... <flow.js> [more-flows.js]" >&2; exit 1; }
    ensure_server
    env DEVICE="$DEVICE" APPIUM_PORT="$APPIUM_PORT" ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
      node "$SCRIPT_DIR/wdio/run-flow.js" "${FLOWS[@]}"
    ;;
  hierarchy)
    # Always a file, never stdout: a raw XML dump into an agent session is
    # large enough to kill the session silently. Grep the file for selectors.
    # Xs must end the template: BSD mktemp leaves embedded Xs literal, so a
    # suffixed template gives one fixed path that fails on the second use.
    OUT="${2:-$(mktemp "${TMPDIR:-/tmp}/kilo-hierarchy.XXXXXX")}"
    ensure_server
    env DEVICE="$DEVICE" APPIUM_PORT="$APPIUM_PORT" node "$SCRIPT_DIR/wdio/hierarchy.js" > "$OUT"
    echo "hierarchy: $OUT ($(grep -c '<' "$OUT") elements)"
    ;;
  *)
    echo "usage: appium.sh <device> test|hierarchy|server|--exec ..." >&2
    exit 1
    ;;
esac
