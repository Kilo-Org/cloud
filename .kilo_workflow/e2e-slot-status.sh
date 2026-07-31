#!/usr/bin/env bash
# Reap dead slot owners, list live holders, then report known resources whose
# worktree has no slot and real booted devices/emulators with no claim record.
# Reporting is read-only and exits 0 — UNACCOUNTED/DEAD lines in the output are
# the findings; the owning workflow or human decides what to stop.
set -euo pipefail
HERE=$(dirname "$0")
"$HERE/.e2e-slot-state.sh" status "$@"

state="$HOME/.cache/kilo-e2e-slots"
covered=$(mktemp)
trap 'rm -f "$covered"' EXIT
for slot in "$state"/slot-*; do
  [ -d "$slot" ] || continue
  cat "$slot/worktree" 2>/dev/null || true
  echo
done > "$covered"

unaccounted=0
dead=0
ios_enum=0
android_enum=0

while IFS= read -r session; do
  # Slug extraction and candidate scheme must match how each session kind was
  # named: kilo-dev-*/emulator records use per-char underscores, cli sessions
  # the collapsing dash slug, stub sessions the raw basename.
  case "$session" in
    kilo-dev-*) slug=${session#kilo-dev-}; scheme=underscore ;;
    kilo-e2e-cli-*) slug=${session#kilo-e2e-cli-}; scheme=dash ;;
    kilo-e2e-github-stub-*) slug=${session#kilo-e2e-github-stub-}; scheme=raw ;;
  esac
  found=0
  while IFS= read -r worktree; do
    [ -n "$worktree" ] || continue
    case "$scheme" in
      underscore) candidate=$(basename "$worktree" | tr -c 'A-Za-z0-9_\n-' '_') ;;
      dash) candidate=$(basename "$worktree" | tr -cs 'a-zA-Z0-9' '-' | sed 's/^-*//;s/-*$//') ;;
      raw) candidate=$(basename "$worktree") ;;
    esac
    [ "$candidate" = "$slug" ] && found=1
  done < "$covered"
  if [ "$found" -eq 0 ]; then
    echo "UNACCOUNTED stack: $session"
    unaccounted=1
  fi
done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^(kilo-dev-|kilo-e2e-cli-|kilo-e2e-github-stub-)' || true)

for root in "${TMPDIR:-/tmp}/kilo-mobile-simulator-claims" \
            "${TMPDIR:-/tmp}/kilo-mobile-android-claims" \
            "${TMPDIR:-/tmp}/kilo-mobile-android-emulators"; do
  [ -d "$root" ] || continue
  for record in "$root"/*.json; do
    [ -f "$record" ] || continue
    worktree=$(sed -nE 's/.*"worktreeRoot"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$record" | head -1)
    [ -n "$worktree" ] || continue
    if ! grep -qxF -- "$worktree" "$covered"; then
      echo "UNACCOUNTED resource: $record [$worktree]"
      unaccounted=1
    fi
  done
done

# Collect booted device ids for claimed-but-dead detection.
ios_booted=$(mktemp)
android_booted=$(mktemp)
dead_printed=$(mktemp)
trap 'rm -f "$covered" "$ios_booted" "$android_booted" "$dead_printed"' EXIT

if command -v xcrun >/dev/null 2>&1; then
  ios_enum=1
  while IFS= read -r line; do
    udid=$(printf '%s' "$line" | sed -nE 's/.*\(([^)]+)\)[[:space:]]*\(Booted\).*/\1/p')
    [ -n "$udid" ] || continue
    printf '%s\n' "$udid" >> "$ios_booted"
    if [ ! -f "${TMPDIR:-/tmp}/kilo-mobile-simulator-claims/${udid}.json" ]; then
      echo "UNACCOUNTED booted device: $udid (no claim record) — if this is not a manual device, stop it: xcrun simctl shutdown $udid"
      unaccounted=1
    fi
  done < <(xcrun simctl list devices booted 2>/dev/null || true)
fi

adb=$(command -v adb 2>/dev/null || true)
if [ -z "$adb" ] && [ -n "${ANDROID_HOME:-}" ] && [ -x "$ANDROID_HOME/platform-tools/adb" ]; then
  adb="$ANDROID_HOME/platform-tools/adb"
fi
if [ -z "$adb" ] && [ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]; then
  adb="$HOME/Library/Android/sdk/platform-tools/adb"
fi

if [ -n "$adb" ]; then
  android_enum=1
  while IFS= read -r line; do
    serial=$(printf '%s' "$line" | awk '/^emulator-/{print $1}')
    state_field=$(printf '%s' "$line" | awk '/^emulator-/{print $2}')
    [ -n "$serial" ] || continue
    [ "$state_field" = "device" ] || continue
    printf '%s\n' "$serial" >> "$android_booted"
    accounted=0
    for root in "${TMPDIR:-/tmp}/kilo-mobile-android-emulators" \
                "${TMPDIR:-/tmp}/kilo-mobile-android-claims"; do
      [ -d "$root" ] || continue
      for record in "$root"/*.json; do
        [ -f "$record" ] || continue
        rec_serial=$(sed -nE 's/.*"serial"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$record" | head -1)
        [ "$rec_serial" = "$serial" ] && accounted=1
      done
    done
    if [ "$accounted" -eq 0 ]; then
      echo "UNACCOUNTED booted emulator: $serial (no claim/emulator record) — verify ownership before stopping: adb -s $serial emu kill"
      unaccounted=1
    fi
  done < <("$adb" devices 2>/dev/null || true)
fi

# Claimed-but-dead detection: records tied to a live slot whose device is gone.
if [ "$ios_enum" -eq 1 ]; then
  for root in "${TMPDIR:-/tmp}/kilo-mobile-simulator-claims"; do
    [ -d "$root" ] || continue
    for record in "$root"/*.json; do
      [ -f "$record" ] || continue
      worktree=$(sed -nE 's/.*"worktreeRoot"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$record" | head -1)
      [ -n "$worktree" ] || continue
      if grep -qxF -- "$worktree" "$covered" >/dev/null 2>&1; then
        id=$(basename "$record" .json)
        if ! grep -qxF -- "$id" "$ios_booted" >/dev/null 2>&1; then
          if ! grep -qxF -- "$id" "$dead_printed" >/dev/null 2>&1; then
            echo "DEAD device: $id claimed by $worktree (slot held) — owner should relaunch or release"
            printf '%s\n' "$id" >> "$dead_printed"
            dead=1
          fi
        fi
      fi
    done
  done
fi

if [ "$android_enum" -eq 1 ]; then
  for root in "${TMPDIR:-/tmp}/kilo-mobile-android-claims" \
              "${TMPDIR:-/tmp}/kilo-mobile-android-emulators"; do
    [ -d "$root" ] || continue
    for record in "$root"/*.json; do
      [ -f "$record" ] || continue
      worktree=$(sed -nE 's/.*"worktreeRoot"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$record" | head -1)
      [ -n "$worktree" ] || continue
      if grep -qxF -- "$worktree" "$covered" >/dev/null 2>&1; then
        serial=$(sed -nE 's/.*"serial"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$record" | head -1)
        [ -n "$serial" ] || continue
        if ! grep -qxF -- "$serial" "$android_booted" >/dev/null 2>&1; then
          if ! grep -qxF -- "$serial" "$dead_printed" >/dev/null 2>&1; then
            echo "DEAD device: $serial claimed by $worktree (slot held) — owner should relaunch or release"
            printf '%s\n' "$serial" >> "$dead_printed"
            dead=1
          fi
        fi
      fi
    done
  done
fi

if [ "$unaccounted" -eq 0 ] && [ "$dead" -eq 0 ]; then
  echo "no unaccounted known resources"
fi
