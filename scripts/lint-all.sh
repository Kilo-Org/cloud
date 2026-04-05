#!/usr/bin/env bash
set -euo pipefail

# Lint all workspace packages. Each workspace with a src/ dir gets linted.
# apps/mobile uses its own oxlint config; everything else shares the root config.

PATH="node_modules/.bin:$PATH"

lint_dirs=(apps/web/src)
mobile_lint_dirs=()

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
  if [ -d "$pkg/src" ]; then
    if [[ "$pkg" == apps/mobile ]]; then
      mobile_lint_dirs+=("$pkg/src")
    else
      lint_dirs+=("$pkg/src")
    fi
  fi
done <<< "$workspace_dirs"

oxlint --config .oxlintrc.json "${lint_dirs[@]}"

if [ ${#mobile_lint_dirs[@]} -gt 0 ]; then
  oxlint --config apps/mobile/.oxlintrc.json "${mobile_lint_dirs[@]}"
fi
