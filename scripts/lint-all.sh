#!/usr/bin/env bash
set -euo pipefail

# Build src paths from pnpm-workspace.yaml. Each workspace with a src/ dir
# gets linted. kilo-app uses its own config; everything else shares the root.

PATH="node_modules/.bin:$PATH"

lint_dirs=(src)
kilo_app_lint_dirs=()

# Parse workspace entries: lines matching "  - <path>" under the "packages:" key.
# Stop when we hit a non-indented, non-comment line that isn't a list item.
in_packages=false
while IFS= read -r line; do
  if [[ "$line" == "packages:" ]]; then
    in_packages=true
    continue
  fi
  if $in_packages; then
    # Stop at next top-level key (any non-blank, non-comment line that doesn't start with whitespace)
    if [[ -n "$line" && ! "$line" =~ ^[[:space:]] && ! "$line" =~ ^# ]]; then
      break
    fi
    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]+(.*) ]]; then
      pkg="${BASH_REMATCH[1]}"
      if [ -d "$pkg/src" ]; then
        if [[ "$pkg" == kilo-app ]]; then
          kilo_app_lint_dirs+=("$pkg/src")
        else
          lint_dirs+=("$pkg/src")
        fi
      fi
    fi
  fi
done < pnpm-workspace.yaml

oxlint --config .oxlintrc.json "${lint_dirs[@]}"

if [ ${#kilo_app_lint_dirs[@]} -gt 0 ]; then
  oxlint --config kilo-app/.oxlintrc.json "${kilo_app_lint_dirs[@]}"
fi
