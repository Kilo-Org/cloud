#!/usr/bin/env bash
set -euo pipefail

# Typecheck all workspace packages.
#
# Usage:
#   scripts/typecheck-all.sh                  # full (all workspace packages)
#   scripts/typecheck-all.sh --changes-only   # incremental (changed packages only)

PATH="node_modules/.bin:$PATH"

changes_only=false
case "${1:-}" in
  --changes-only) changes_only=true ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 1 ;;
esac

base=""
if $changes_only; then
  base=$(git merge-base origin/main HEAD 2>/dev/null || true)
  if [ -z "$base" ]; then
    echo "[typecheck] no merge base found, running full typecheck"
    changes_only=false
  fi
fi

# 1. Build trpc (skip if --changes-only and source unchanged)
if $changes_only; then
  trpc_changed=$(git diff --name-only "$base" -- 'packages/trpc/src/**' 'packages/trpc/tsconfig.json' 'packages/trpc/rollup.config.mjs' 'packages/trpc/package.json' | head -1 || true)
  if [ -n "$trpc_changed" ]; then
    echo "[typecheck] trpc source changed, rebuilding"
    pnpm --filter @kilocode/trpc run build
  else
    echo "[typecheck] trpc source unchanged, skipping build"
  fi
else
  pnpm --filter @kilocode/trpc run build
fi

# 2. Root typecheck (always — it's fast with incremental tsgo)
tsgo --noEmit

# 3. Workspace typecheck
if ! $changes_only; then
  echo "[typecheck] checking all workspace packages"
  pnpm -r --filter '!kilocode-backend' --filter '!@kilocode/trpc' run typecheck
  exit 0
fi

# Incremental: find workspace packages with TS or config changes and typecheck only those.
# Also fall back to full typecheck if pnpm-workspace.yaml changed (catalog bumps can
# alter the type surface across packages).
if git diff --name-only "$base" -- pnpm-workspace.yaml | grep -q .; then
  echo "[typecheck] pnpm-workspace.yaml changed, rebuilding trpc and running full workspace typecheck"
  pnpm --filter @kilocode/trpc run build
  pnpm -r --filter '!kilocode-backend' --filter '!@kilocode/trpc' run typecheck
  exit 0
fi

changed_dirs=$(git diff --name-only "$base" -- '*.ts' '*.tsx' '**/tsconfig*.json' '**/package.json' | \
  { grep -v '^src/' || true; } | \
  sed 's|/src/.*||; s|/[^/]*\.[^/]*$||' | \
  sort -u)

if [ -z "$changed_dirs" ]; then
  echo "[typecheck] no workspace changes, skipping workspace typecheck"
  exit 0
fi

# Map directories to pnpm package names and include dependents
pnpm_filters=()
while IFS= read -r dir; do
  [ -z "$dir" ] && continue
  [ -f "$dir/package.json" ] || continue
  name=$(node -e "console.log(require('./$dir/package.json').name || '')" 2>/dev/null)
  [ -z "$name" ] && continue
  [[ "$name" == "kilocode-backend" ]] && continue
  [[ "$name" == "@kilocode/trpc" ]] && continue
  pnpm_filters+=(--filter "$name...")
done <<< "$changed_dirs"

if [ ${#pnpm_filters[@]} -eq 0 ]; then
  echo "[typecheck] no matching workspace packages, skipping workspace typecheck"
  exit 0
fi

echo "[typecheck] checking affected packages: ${pnpm_filters[*]}"
pnpm -r "${pnpm_filters[@]}" --filter '!kilocode-backend' --filter '!@kilocode/trpc' run typecheck
