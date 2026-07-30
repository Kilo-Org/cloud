#!/usr/bin/env bash
# Free this session's E2E slot. Refuses while this worktree still owns live
# resources — a slot freed with leftovers is exactly the UNACCOUNTED state
# e2e-slot-status.sh reports, and it starves parallel runs. Stop resources
# through e2e-stop-resource.sh first.
set -euo pipefail
HERE=$(dirname "$0")
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
# Per-character replacement, matching dev/local/tmux.ts getSessionName.
SLUG_="$(basename "$ROOT" | sed 's/[^A-Za-z0-9_-]/_/g')"
SLUG_DASH="$(basename "$ROOT" | tr -cs 'a-zA-Z0-9' '-' | sed 's/^-*//;s/-*$//')"

leftovers=()
if command -v tmux >/dev/null; then
  while IFS= read -r session; do
    case "$session" in
      "kilo-dev-$SLUG_"|"kilo-e2e-android-$SLUG_"|"kilo-e2e-cli-$SLUG_DASH"|"kilo-e2e-github-stub-$(basename "$ROOT")")
        leftovers+=("tmux session: $session") ;;
    esac
  done < <(tmux ls -F '#S' 2>/dev/null || true)
fi

for claims_dir in "${TMPDIR:-/tmp}/kilo-mobile-simulator-claims" "${TMPDIR:-/tmp}/kilo-mobile-android-claims"; do
  [ -d "$claims_dir" ] || continue
  for json in "$claims_dir"/*.json; do
    [ -f "$json" ] || continue
    node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));process.exit(r.worktreeRoot===process.argv[2]?0:1)' "$json" "$ROOT" 2>/dev/null || continue
    leftovers+=("device claim: $json")
  done
done

if [ "${#leftovers[@]}" -gt 0 ]; then
  printf 'refusing to free the slot while this worktree still owns resources:\n' >&2
  printf '  %s\n' "${leftovers[@]}" >&2
  printf 'stop each by kind: stack/device claim -> %s/e2e-stop-resource.sh stack|ios|android; kilo-e2e-cli-* -> apps/mobile/e2e/remote-cli.sh stop; kilo-e2e-github-stub-* -> tmux kill-session -t <name>\n' "$HERE" >&2
  exit 1
fi

exec "$HERE/.e2e-slot-state.sh" release "$@"
