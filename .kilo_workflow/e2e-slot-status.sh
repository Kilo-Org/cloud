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
  slug=${session#kilo-dev-}
  found=0
  while IFS= read -r worktree; do
    [ -n "$worktree" ] || continue
    candidate=$(basename "$worktree" | tr -c 'A-Za-z0-9_\n-' '_')
    [ "$candidate" = "$slug" ] && found=1
  done < "$covered"
  if [ "$found" -eq 0 ]; then
    echo "UNACCOUNTED stack: $session"
    unaccounted=1
  fi
done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^kilo-dev-' || true)

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
