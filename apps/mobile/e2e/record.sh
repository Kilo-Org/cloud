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

# State is KEY=VALUE lines. Values are base64-encoded so paths with spaces or
# shell metacharacters round-trip without eval/source. Encode/decode failures
# are fatal — never silently empty a pid (that would turn stop into a no-op
# while the recorder keeps running).
b64_encode() {
  local out
  out=$(printf '%s' "$1" | base64 | tr -d '\n') || {
    echo "record.sh: base64 encode failed" >&2
    return 1
  }
  [ -n "$out" ] || {
    echo "record.sh: base64 encode produced empty output" >&2
    return 1
  }
  printf '%s' "$out"
}

b64_decode() {
  local out
  out=$(printf '%s' "$1" | base64 -d 2>/dev/null) || {
    echo "record.sh: base64 decode failed for state value" >&2
    return 1
  }
  printf '%s' "$out"
}

read_state() {
  platform='' pid='' path='' remote=''
  [ -f "$STATE_FILE" ] || return 0
  local line key value decoded
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      platform | pid | path | remote)
        decoded=$(b64_decode "$value") || return 1
        case "$key" in
          platform) platform=$decoded ;;
          pid)
            [ -n "$decoded" ] || {
              echo "record.sh: empty pid in state file" >&2
              return 1
            }
            pid=$decoded
            ;;
          path) path=$decoded ;;
          remote) remote=$decoded ;;
        esac
        ;;
    esac
  done <"$STATE_FILE"
}

write_state() {
  # usage: write_state key value ...
  : >"$STATE_FILE"
  while [ $# -ge 2 ]; do
    printf '%s=%s\n' "$1" "$(b64_encode "$2")" >>"$STATE_FILE" || return 1
    shift 2
  done
}

clear_state() {
  rm -rf "$STATE_DIR"
}

require_dir() {
  local dir
  dir=$(dirname "$1")
  [ -d "$dir" ] || mkdir -p "$dir"
}

# True when $1 is live and its command line looks like our recorder (not a
# recycled PID of an unrelated process). Use -ww so BSD ps does not truncate
# the command column to the terminal width (no-tty default is ~79 cols).
recorder_pid_live() {
  local pid=$1 expect=$2 cmd
  kill -0 "$pid" 2>/dev/null || return 1
  cmd=$(ps -ww -p "$pid" -o command= 2>/dev/null || ps -p "$pid" -o args= 2>/dev/null || true)
  [ -n "$cmd" ] || return 1
  case "$cmd" in
    *"$expect"*) return 0 ;;
    *) return 1 ;;
  esac
}

stop_ios() {
  local pid path waited was_live=0
  pid=$1
  path=$2
  if recorder_pid_live "$pid" "recordVideo"; then
    was_live=1
    kill -INT "$pid" 2>/dev/null || true
    waited=0
    while [ "$waited" -lt 15 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "record.sh: iOS recorder on $DEVICE did not exit after SIGINT" >&2
      return 2
    fi
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

stop_android() {
  local pid path remote adb waited remaining was_live=0
  pid=$1
  path=$2
  remote=${3:-}
  adb=$(resolve_adb) || { echo "record.sh: adb not found" >&2; return 1; }
  if recorder_pid_live "$pid" "screenrecord"; then
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
    # Drop the remote so a later failed segment cannot pull a prior video.
    "$adb" -s "$DEVICE" shell rm -f "$remote" >/dev/null 2>&1 || true
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
      if recorder_pid_live "$pid" "recordVideo" || recorder_pid_live "$pid" "screenrecord"; then
        echo "record.sh: already recording on $DEVICE (pid $pid)" >&2
        exit 1
      fi
      # Stale pid recycled by an unrelated process — clear and start fresh.
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
        # Clear any prior segment so a failed new recording cannot pull stale video.
        "$ADB" -s "$DEVICE" shell rm -f "$REMOTE" >/dev/null 2>&1 || true
        (
          trap '' HUP
          exec "$ADB" -s "$DEVICE" shell screenrecord --time-limit 170 --size 1280x720 "$REMOTE"
        ) >/dev/null 2>&1 &
        write_state platform android pid "$!" path "$VIDEO" remote "$REMOTE"
        expect=screenrecord
        ;;
      *)
        command -v xcrun >/dev/null 2>&1 || { echo "record.sh: xcrun not found" >&2; exit 1; }
        (
          trap '' HUP
          exec xcrun simctl io "$DEVICE" recordVideo --codec h264 --force "$VIDEO"
        ) >/dev/null 2>&1 &
        write_state platform ios pid "$!" path "$VIDEO"
        expect=recordVideo
        ;;
    esac
    # Give the recorder a beat to install signal handlers, then require liveness.
    sleep 0.2
    rec_pid=
    read_state
    rec_pid=${pid:-}
    if [ -z "$rec_pid" ] || ! recorder_pid_live "$rec_pid" "$expect"; then
      # If the probe is wrong but the pid is still live, SIGINT it before drop.
      if [ -n "$rec_pid" ] && kill -0 "$rec_pid" 2>/dev/null; then
        kill -INT "$rec_pid" 2>/dev/null || true
      fi
      clear_state
      echo "record.sh: recorder failed to stay up on $DEVICE" >&2
      exit 1
    fi
    echo "record.sh: started $DEVICE recorder -> $VIDEO" >&2
    ;;

  stop)
    if ! read_state; then
      echo "record.sh: corrupt state for $DEVICE; not clearing so a human can inspect $STATE_FILE" >&2
      exit 1
    fi
    if [ -z "${pid:-}" ]; then
      echo "record.sh: no active recording for $DEVICE" >&2
      exit 0
    fi
    case "${platform:-}" in
      ios)
        if ! stop_ios "$pid" "${path:-}"; then
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
