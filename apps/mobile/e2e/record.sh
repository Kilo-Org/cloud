#!/usr/bin/env bash
# Segment-scoped screen recorder for E2E evidence. Does NOT take the Appium
# device lock — recording does not drive the device.
#
#   record.sh <udid|serial> start <video-path>
#   record.sh <udid|serial> stop
#   record.sh frame <video-path> <hh:mm:ss> <out.png>
#
# iOS uses simctl recordVideo (no duration cap). Android uses adb shell
# screenrecord, which caps at ~3 minutes; record in segments, never one
# whole-route video. Stop is idempotent so bundle cleanup can call it blindly.
set -euo pipefail

resolve_adb() {
  local candidate found
  found=$(command -v adb 2>/dev/null || true)
  for candidate in "$found" "${ANDROID_HOME:-}/platform-tools/adb" "$HOME/Library/Android/sdk/platform-tools/adb"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

read_state() {
  platform='' pid='' path='' remote=''
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
  fi
}

clear_state() {
  rm -rf "$STATE_DIR"
}

require_dir() {
  local dir
  dir=$(dirname "$1")
  [ -d "$dir" ] || mkdir -p "$dir"
}

stop_ios() {
  local pid path waited was_live=0
  pid=$1
  path=$2
  if kill -0 "$pid" 2>/dev/null; then
    was_live=1
    kill -INT "$pid" 2>/dev/null || true
    waited=0
    while [ "$waited" -lt 15 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      # Keep state so a later stop can re-signal; do not orphan tracking.
      echo "record.sh: iOS recorder on $DEVICE did not exit after SIGINT" >&2
      return 2
    fi
  fi
  if [ ! -s "$path" ]; then
    if [ "$was_live" -eq 1 ]; then
      # Active stop that failed to finalize — keep state, fail so callers fall back.
      echo "record.sh: no finalized video at $path" >&2
      return 1
    fi
    # Stale state, no live recorder: cleanup no-op.
    echo "record.sh: no active recording for $DEVICE" >&2
    return 0
  fi
  local size
  size=$(stat -f%z "$path" 2>/dev/null || stat -c%s "$path" 2>/dev/null || echo 0)
  echo "$path $size"
  return 0
}

stop_android() {
  local pid path remote adb waited remaining was_live=0
  pid=$1
  path=$2
  remote=${3:-}
  adb=$(resolve_adb) || { echo "record.sh: adb not found" >&2; return 1; }
  if kill -0 "$pid" 2>/dev/null; then
    was_live=1
  fi
  remaining=$("$adb" -s "$DEVICE" shell pidof screenrecord 2>/dev/null | tr -d '[:space:]') || remaining=''
  [ -n "$remaining" ] && was_live=1
  "$adb" -s "$DEVICE" shell pkill -INT screenrecord >/dev/null 2>&1 || true
  waited=0
  while [ "$waited" -lt 15 ]; do
    remaining=$("$adb" -s "$DEVICE" shell pidof screenrecord 2>/dev/null | tr -d '[:space:]') || remaining=''
    [ -z "$remaining" ] && break
    sleep 1
    waited=$((waited + 1))
  done
  remaining=$("$adb" -s "$DEVICE" shell pidof screenrecord 2>/dev/null | tr -d '[:space:]') || remaining=''
  if [ -n "$remaining" ]; then
    echo "record.sh: Android screenrecord on $DEVICE still running after SIGINT" >&2
    return 2
  fi
  if kill -0 "$pid" 2>/dev/null; then
    waited=0
    while [ "$waited" -lt 5 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
    done
  fi
  if [ -n "$remote" ]; then
    "$adb" -s "$DEVICE" pull "$remote" "$path" >/dev/null 2>&1 || true
  fi
  if [ ! -s "$path" ]; then
    if [ "$was_live" -eq 1 ]; then
      echo "record.sh: no finalized video at $path" >&2
      return 1
    fi
    echo "record.sh: no active recording for $DEVICE" >&2
    return 0
  fi
  local size
  size=$(stat -f%z "$path" 2>/dev/null || stat -c%s "$path" 2>/dev/null || echo 0)
  echo "$path $size"
  return 0
}

usage() {
  echo "usage: record.sh <udid|serial> start <video-path>" >&2
  echo "       record.sh <udid|serial> stop" >&2
  echo "       record.sh frame <video-path> <hh:mm:ss> <out.png>" >&2
  exit 1
}

if [ "${1:-}" = "frame" ]; then
  VIDEO="${2:?usage: record.sh frame <video-path> <hh:mm:ss> <out.png>}"
  TS="${3:?usage: record.sh frame <video-path> <hh:mm:ss> <out.png>}"
  OUT="${4:?usage: record.sh frame <video-path> <hh:mm:ss> <out.png>}"
  command -v ffmpeg >/dev/null 2>&1 || { echo "record.sh: ffmpeg not found" >&2; exit 1; }
  ffmpeg -i "$VIDEO" -ss "$TS" -frames:v 1 -y "$OUT" >/dev/null 2>&1
  exit 0
fi

DEVICE="${1:?usage: record.sh <udid|serial> start|stop   or   record.sh frame <video> <ts> <out.png>}"
shift

STATE_DIR="${TMPDIR:-/tmp}/kilo-e2e-record/$DEVICE"
STATE_FILE="$STATE_DIR/state"

cmd="${1:-}"
case "$cmd" in
  start)
    VIDEO="${2:?usage: record.sh <device> start <video-path>}"
    read_state
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      echo "record.sh: already recording on $DEVICE (pid $pid)" >&2
      exit 1
    fi
    clear_state
    mkdir -p "$STATE_DIR"
    require_dir "$VIDEO"
    # Subshell ignores SIGHUP then execs the recorder so $! is the real
    # process (not a wrapper) and the recorder survives start's exit.
    # stop SIGINTs that pid to finalize — never SIGKILL.
    case "$DEVICE" in
      emulator-*)
        ADB=$(resolve_adb) || { echo "record.sh: adb not found" >&2; exit 1; }
        REMOTE="/sdcard/kilo-e2e-record.mp4"
        (
          trap '' HUP
          exec "$ADB" -s "$DEVICE" shell screenrecord --time-limit 170 --size 1280x720 "$REMOTE"
        ) >/dev/null 2>&1 &
        echo "platform=android" > "$STATE_FILE"
        echo "pid=$!" >> "$STATE_FILE"
        echo "path=$VIDEO" >> "$STATE_FILE"
        echo "remote=$REMOTE" >> "$STATE_FILE"
        ;;
      *)
        (
          trap '' HUP
          exec xcrun simctl io "$DEVICE" recordVideo --codec h264 --force "$VIDEO"
        ) >/dev/null 2>&1 &
        echo "platform=ios" > "$STATE_FILE"
        echo "pid=$!" >> "$STATE_FILE"
        echo "path=$VIDEO" >> "$STATE_FILE"
        ;;
    esac
    # Give the recorder a beat to install signal handlers before stop can race.
    sleep 0.2
    echo "record.sh: started $DEVICE recorder -> $VIDEO" >&2
    ;;

  stop)
    read_state
    if [ -z "${pid:-}" ]; then
      echo "record.sh: no active recording for $DEVICE" >&2
      exit 0
    fi
    case "${platform:-}" in
      ios)
        if ! stop_ios "$pid" "${path:-}"; then
          # rc 1 = empty finalize after live stop; rc 2 = still live — keep state
          exit 1
        fi
        ;;
      android)
        if ! stop_android "$pid" "${path:-}" "${remote:-}"; then
          exit 1
        fi
        ;;
      *)
        echo "record.sh: unknown platform '${platform:-}' in state file" >&2
        clear_state
        exit 1
        ;;
    esac
    clear_state
    ;;

  *)
    usage
    ;;
esac
