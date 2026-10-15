#!/usr/bin/env bash
set -euo pipefail

# Lint all workspace packages. Each workspace with a src/ dir gets linted.
# apps/mobile uses its own oxlint config; everything else shares the root config.
#
# Usage:
#   scripts/lint-all.sh                  # every workspace
#   scripts/lint-all.sh --group <name>   # CI: one group of KILO_AFFECTED
#
# Groups split the work across parallel CI jobs:
#   trpc  apps/mobile and apps/extension, which lint against the built tRPC types
#   rest  every other workspace
# KILO_AFFECTED is the JSON printed by scripts/affected-workspaces.mjs.

PATH="node_modules/.bin:$PATH"

group=""
case "${1:-}" in
  --group) group="${2:?--group needs trpc or rest}" ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 1 ;;
esac

full=true
affected='{}'
if [ -n "$group" ]; then
  affected="${KILO_AFFECTED:?KILO_AFFECTED is required with --group}"
  full=$(jq -r '.full or (.full_checks | index("lint") != null)' <<< "$affected")
fi
affects() {
  [ "$full" = true ] || jq -e --arg dir "$1" '.dirs | index($dir)' <<< "$affected" > /dev/null
}
in_group() {
  case "$group" in
    "") return 0 ;;
    trpc) [[ "$1" == apps/mobile || "$1" == apps/extension ]] ;;
    rest) [[ "$1" != apps/mobile && "$1" != apps/extension ]] ;;
    *) echo "Unknown group: $group" >&2; exit 1 ;;
  esac
}

lint_dirs=()
mobile_lint_dirs=()
if in_group apps/web && affects apps/web; then
  lint_dirs+=(apps/web/src scripts/web-env)
fi

# Resolve workspace directories using pnpm (handles glob expansion)
workspace_dirs=$(pnpm ls --json -r --depth -1 2>/dev/null | node -e "
  const pkgs = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  for (const p of pkgs) {
    if (!p.path) continue;
    const rel = require('path').relative(process.cwd(), p.path);
    if (rel && rel !== '.') console.log(rel);
  }
")

while IFS= read -r pkg; do
  [ -z "$pkg" ] && continue
  # Machine-image packages join workspace for dependency resolution, not lint scope.
  case "$pkg" in
    services/kiloclaw/controller | services/kiloclaw/plugins/*)
      continue
      ;;
  esac
  in_group "$pkg" || continue
  affects "$pkg" || continue
  if [ -d "$pkg/src" ]; then
    if [[ "$pkg" == apps/mobile ]]; then
      mobile_lint_dirs+=("$pkg/src")
    else
      lint_dirs+=("$pkg/src")
    fi
  fi
done <<< "$workspace_dirs"

if [ ${#lint_dirs[@]} -gt 0 ]; then
  oxlint --config .oxlintrc.json "${lint_dirs[@]}"
fi

if [ ${#mobile_lint_dirs[@]} -gt 0 ]; then
  oxlint --config apps/mobile/.oxlintrc.json "${mobile_lint_dirs[@]}"
fi
