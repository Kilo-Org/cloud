#!/usr/bin/env bash
set -euo pipefail

# Typecheck all workspace packages.
#
# Usage:
#   scripts/typecheck-all.sh                  # full (all workspace packages)
#   scripts/typecheck-all.sh --changes-only   # incremental (changed packages only)
#   scripts/typecheck-all.sh --group <name>   # CI: one group of KILO_AFFECTED
#
# Groups split the work across parallel CI jobs:
#   web       apps/web, scripts/web-env and storybook
#   trpc      the tRPC build and the apps that compile against it
#   packages  every other workspace package
# KILO_AFFECTED is the JSON printed by scripts/affected-workspaces.mjs.

PATH="node_modules/.bin:$PATH"

changes_only=false
group=""
case "${1:-}" in
  --changes-only) changes_only=true ;;
  --group) group="${2:?--group needs web, trpc or packages}" ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 1 ;;
esac

# Exclude the root package so the recursive workspace typecheck does not invoke
# this script again.
workspace_typecheck_filters=(--filter '!kilocode-monorepo' --filter '!web' --filter '!@kilocode/trpc')

if [ -n "$group" ]; then
  affected="${KILO_AFFECTED:?KILO_AFFECTED is required with --group}"
  full=$(jq -r '.full or (.full_checks | index("typecheck") != null)' <<< "$affected")
  affects() {
    [ "$full" = true ] || jq -e --arg name "$1" '.packages | index($name)' <<< "$affected" > /dev/null
  }
  case "$group" in
    web)
      if affects web; then
        tsgo --noEmit -p apps/web/tsconfig.json
        tsgo --noEmit -p scripts/web-env/tsconfig.json
      fi
      if affects @kilocode/storybook; then
        pnpm --filter @kilocode/storybook run typecheck
      fi
      ;;
    trpc)
      # kilo-app typechecks in kilo-app CI, which runs whenever kilo-app is
      # affected. The extension has no other job that typechecks it outside its
      # own workflow, which skips unrelated PRs.
      pnpm --filter @kilocode/trpc run build
      export KILO_TYPECHECK_TRPC_BUILT=1
      if affects kilo-extension; then
        pnpm --filter kilo-extension run typecheck
      fi
      ;;
    packages)
      # The web, trpc and extension checks belong to their own groups.
      # kilo-app typechecks in kilo-app CI, which runs whenever kilo-app is
      # affected; its typecheck needs the compiled harness SDK, which this
      # group does not build.
      excluded=(
        --filter '!@kilocode/storybook'
        --filter '!kilo-app'
        --filter '!kilo-extension'
      )
      if [ "$full" = true ]; then
        pnpm -r "${workspace_typecheck_filters[@]}" "${excluded[@]}" run typecheck
        exit 0
      fi
      filters=()
      while IFS= read -r name; do
        case "$name" in
          web | @kilocode/trpc | @kilocode/storybook | kilo-app | kilo-extension) ;;
          *) filters+=(--filter "$name") ;;
        esac
      done < <(jq -r '.packages[]' <<< "$affected")
      if [ ${#filters[@]} -gt 0 ]; then
        pnpm -r "${filters[@]}" run typecheck
      fi
      ;;
    *) echo "Unknown group: $group" >&2; exit 1 ;;
  esac
  exit 0
fi

base=""
if $changes_only; then
  base=$(git merge-base origin/main HEAD 2>/dev/null || true)
  if [ -z "$base" ]; then
    echo "[typecheck] no merge base found, running full typecheck"
    changes_only=false
  # Catalog bumps in pnpm-workspace.yaml can alter the type surface across packages.
  elif git diff --name-only "$base" -- pnpm-workspace.yaml | grep -q .; then
    echo "[typecheck] pnpm-workspace.yaml changed, running full typecheck"
    changes_only=false
  fi
fi

# 1. Build trpc (skip if --changes-only and source unchanged)
if $changes_only; then
  trpc_changed=$(git diff --name-only "$base" -- 'packages/trpc/src/**' 'packages/trpc/tsconfig.json' 'packages/trpc/rollup.config.mjs' 'packages/trpc/package.json' | head -1 || true)
  if [ -n "$trpc_changed" ]; then
    echo "[typecheck] trpc source changed, rebuilding"
    pnpm --filter @kilocode/trpc run build
    export KILO_TYPECHECK_TRPC_BUILT=1
  else
    echo "[typecheck] trpc source unchanged, skipping build"
  fi
else
  pnpm --filter @kilocode/trpc run build
  export KILO_TYPECHECK_TRPC_BUILT=1
fi

# 1b. Build the harness SDK, which apps/mobile typechecks against (same rule as trpc)
if $changes_only; then
  harness_changed=$(git diff --name-only "$base" -- 'packages/harness-sdk/src/**' 'packages/harness-sdk/tsconfig.json' 'packages/harness-sdk/package.json' | head -1 || true)
  if [ -n "$harness_changed" ]; then
    echo "[typecheck] harness-sdk source changed, rebuilding"
    pnpm --filter @kilocode/harness-sdk run build
  else
    echo "[typecheck] harness-sdk source unchanged, skipping build"
  fi
else
  pnpm --filter @kilocode/harness-sdk run build
fi

# 2. Root typechecks (always — they are fast with incremental tsgo)
tsgo --noEmit -p apps/web/tsconfig.json
tsgo --noEmit -p scripts/web-env/tsconfig.json

# 3. Workspace typecheck
if ! $changes_only; then
  echo "[typecheck] checking all workspace packages"
  pnpm -r "${workspace_typecheck_filters[@]}" run typecheck
  exit 0
fi

# Incremental: find workspace packages with TS or config changes and typecheck only those.
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
  [[ "$name" == "web" ]] && continue
  [[ "$name" == "@kilocode/trpc" ]] && continue
  pnpm_filters+=(--filter "$name...")
done <<< "$changed_dirs"

if [ ${#pnpm_filters[@]} -eq 0 ]; then
  echo "[typecheck] no matching workspace packages, skipping workspace typecheck"
  exit 0
fi

echo "[typecheck] checking affected packages: ${pnpm_filters[*]}"
pnpm -r "${pnpm_filters[@]}" "${workspace_typecheck_filters[@]}" run typecheck
