#!/usr/bin/env bash
set -euo pipefail

# Output a JSON matrix of workspace packages that have file changes and a test script.
# Excludes the root package and packages listed in --exclude arguments.
#
# Usage:
#   scripts/changed-workspaces.sh                                    # all changed workspaces with tests
#   scripts/changed-workspaces.sh --exclude services/cloud-agent-next --exclude apps/web  # skip specific dirs

excludes=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --exclude)
      if [[ $# -lt 2 ]]; then
        echo "Error: --exclude requires a value" >&2; exit 1
      fi
      excludes+=("$2"); shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

base=$(git merge-base origin/main HEAD 2>/dev/null || true)

# Decide selection mode:
#   force_all=true — include every workspace (lockfile/workspace-yaml changes
#     genuinely can break any downstream workspace, and loose `packages/*` files
#     outside any package dir don't have a single owner to derive dependents of).
#   force_all=false and dependent_dirs_file populated — a `packages/<name>/**`
#     path changed; only include that package plus its transitive workspace:*
#     dependents.
#   force_all=false and dependent_dirs_file empty — fall back to per-workspace
#     direct file-diff check.
force_all=false
dependent_dirs_file=$(mktemp)
trap 'rm -f "$dependent_dirs_file"' EXIT
if [ -n "$base" ]; then
  if git diff --name-only "$base" -- pnpm-lock.yaml pnpm-workspace.yaml | grep -q .; then
    force_all=true
  else
    # List files changed under packages/**. Anything that doesn't match
    # `packages/<name>/` (e.g. `packages/README.md`) is a loose file with no
    # single owning package — fall back to force_all.
    pkg_changes=$(git diff --name-only "$base" -- 'packages/**' || true)
    if [ -n "$pkg_changes" ]; then
      loose=$(printf '%s\n' "$pkg_changes" | grep -vE '^packages/[^/]+/' | head -1 || true)
      if [ -n "$loose" ]; then
        force_all=true
      else
        # Collect the top-level changed package dirs and union their transitive
        # workspace:* dependents via pnpm's `...^<name>` selector.
        changed_pkg_dirs=$(printf '%s\n' "$pkg_changes" | awk -F/ '{print $1"/"$2}' | sort -u)
        for pkg_dir in $changed_pkg_dirs; do
          [ -f "$pkg_dir/package.json" ] || continue
          pkg_name=$(node -e "console.log(require('./$pkg_dir/package.json').name)" 2>/dev/null) || continue
          [ -n "$pkg_name" ] || continue
          pnpm --filter "...^$pkg_name" ls --json --depth -1 2>/dev/null | node -e "
            const pkgs = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            for (const p of pkgs) {
              if (!p.path) continue;
              const rel = require('path').relative(process.cwd(), p.path);
              if (rel && rel !== '.') console.log(rel);
            }
          " 2>/dev/null >> "$dependent_dirs_file" || true
          # Always include the changed package itself; `...^<name>` only matches
          # true dependents, not the named package.
          echo "$pkg_dir" >> "$dependent_dirs_file"
        done
        sort -u "$dependent_dirs_file" -o "$dependent_dirs_file"
      fi
    fi
  fi
fi

# Read workspace dirs using pnpm (handles glob expansion in pnpm-workspace.yaml)
workspace_dirs=$(pnpm ls --json -r --depth -1 2>/dev/null | node -e "
  const pkgs = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  for (const p of pkgs) {
    if (!p.path) continue;
    const rel = require('path').relative(process.cwd(), p.path);
    if (rel && rel !== '.') console.log(rel);
  }
")

# Collect entries as newline-delimited "name\tdir" pairs, then serialize to JSON once
entries=""
for dir in $workspace_dirs; do
  # Skip excluded dirs
  skip=false
  for ex in "${excludes[@]+"${excludes[@]}"}"; do
    if [[ "$dir" == "$ex" || "$dir" == "$ex/"* ]]; then
      skip=true
      break
    fi
  done
  $skip && continue

  # Must have a package.json with a test script
  [ -f "$dir/package.json" ] || continue
  has_test=$(node -e "const p=require('./$dir/package.json'); console.log(p.scripts?.test ? '1' : '')" 2>/dev/null)
  [ -n "$has_test" ] || continue

  # Skip workspaces whose test script exists but has no test files.
  # `-print -quit` stops find after the first match and prints it, avoiding
  # a `find | head -1` pipeline — on Linux that produces SIGPIPE on find,
  # which under `set -o pipefail` propagates as a non-zero pipeline exit.
  test_file_count=$(find "$dir" -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.jsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.spec.js' -o -name '*.spec.jsx' \) -not -path '*/node_modules/*' -print -quit 2>/dev/null)
  [ -n "$test_file_count" ] || continue

  # Check for file changes (if we have a merge base)
  if [ -n "$base" ] && ! $force_all; then
    if [ -s "$dependent_dirs_file" ] && grep -qxF "$dir" "$dependent_dirs_file"; then
      : # include: workspace is a transitive dependent of a changed package
    else
      changed_file=$(git diff --name-only "$base" -- "$dir/" | head -1 || true)
      [ -n "$changed_file" ] || continue
    fi
  fi

  name=$(node -e "console.log(require('./$dir/package.json').name)" 2>/dev/null)
  entries+="${name}"$'\t'"${dir}"$'\n'
done

# Serialize all entries to JSON in a single node invocation (avoids shell interpolation issues)
if [ -z "$entries" ]; then
  echo "[]"
else
  echo -n "$entries" | node -e "
    const lines = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n');
    const matrix = lines.map(line => {
      const [name, dir] = line.split('\t');
      return { name, dir };
    });
    console.log(JSON.stringify(matrix));
  "
fi
