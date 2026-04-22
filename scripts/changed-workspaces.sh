#!/usr/bin/env bash
set -euo pipefail

# Output a JSON matrix of workspace packages that have file changes and a test script.
# Excludes the root package and packages listed in --exclude arguments.
#
# Usage:
#   scripts/changed-workspaces.sh                                    # all changed workspaces with tests
#   scripts/changed-workspaces.sh --exclude services/cloud-agent --exclude services/cloud-agent-next  # skip specific dirs

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

# If shared inputs changed, treat all workspaces as changed — shared package or
# lockfile updates can break any downstream workspace.
shared_changed=false
if [ -n "$base" ]; then
  if git diff --name-only "$base" -- pnpm-lock.yaml pnpm-workspace.yaml 'packages/**' | grep -q .; then
    shared_changed=true
  fi
fi

# Read workspace dirs using pnpm (handles glob expansion in pnpm-workspace.yaml)
workspace_dirs=$(pnpm ls --json -r --depth -1 | node -e "
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
  # Use -print -quit to avoid SIGPIPE failures from find|head under pipefail.
  test_file_count=$(find "$dir" -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.jsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.spec.js' -o -name '*.spec.jsx' \) -not -path '*/node_modules/*' -print -quit 2>/dev/null)
  [ -n "$test_file_count" ] || continue

  # Check for file changes (if we have a merge base)
  if [ -n "$base" ] && ! $shared_changed; then
    changed_file=$(git diff --name-only "$base" -- "$dir/" | head -1 || true)
    [ -n "$changed_file" ] || continue
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
