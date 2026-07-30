#!/usr/bin/env bash
# Reap dead slot owners, list live holders, then report known resources whose
# worktree has no slot. Reporting is read-only and exits 0 — UNACCOUNTED lines
# in the output are the finding; the owning workflow cleans up. Passing any
# argument is a usage error (exit 1).
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

if [ "$unaccounted" -eq 0 ]; then
  echo "no unaccounted known resources"
fi
