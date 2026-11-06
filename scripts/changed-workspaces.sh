#!/usr/bin/env bash
set -euo pipefail

# Output a JSON matrix of workspace packages that have file changes and a test script.
# Excludes the root package and packages listed in --exclude arguments. Each
# --include dir is selected as if it had file changes.
#
# The selection comes from one invocation of scripts/affected-workspaces.mjs: it
# owns the workspace inventory, the reader and dependent closure, the lockfile
# closure (scripts/changed-dependencies.mjs), and it excludes documents and
# neutral root locations before any manifest read or file probe. The matrix then
# keeps, of the selected directories, the ones with a test script and a test file.
#
# A caller that already ran the detector for the same base passes its document as
# AFFECTED (ci.yml's changes job does), and the matrix decides from it instead of
# selecting the repository a second time in the same run.
#
# Usage:
#   scripts/changed-workspaces.sh                                    # all changed workspaces with tests
#   scripts/changed-workspaces.sh --exclude services/cloud-agent-next --exclude apps/web  # skip specific dirs
#   scripts/changed-workspaces.sh --include services/latency-ingest  # also select a dir

excludes=()
includes=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --exclude|--include)
      if [[ $# -lt 2 ]]; then
        echo "Error: $1 requires a value" >&2; exit 1
      fi
      if [[ "$1" == --exclude ]]; then excludes+=("$2"); else includes+=("$2"); fi
      shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Compute the diff base SHA by GitHub event type.
# - `push` event: use the BEFORE sha from $GITHUB_EVENT_PATH so the diff covers
#   the pushed range. `git merge-base origin/main HEAD` on a push to main
#   resolves to HEAD, which would produce an empty matrix and skip the
#   workspace-tests job.
# - `pull_request` and `merge_group` events: use the PR base SHA or the merge
#   group base SHA from $GITHUB_EVENT_PATH. On pull requests this is the base
#   the affected workspace detector uses; in the merge queue that detector
#   checks every workspace instead. For a stacked PR the base is the parent
#   branch, so the matrix covers this PR's changes, not the whole stack's.
# - Otherwise (or when that SHA is unavailable, and locally with no GitHub
#   env): use the merge-base against origin/main.
# - All-zeros before-sha (force-push / first push / branch creation) or any
#   invalid/unreachable before-sha falls back to HEAD~1.
base=""
if [ "${GITHUB_EVENT_NAME:-}" = "push" ] && [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ]; then
  before=$(jq -r '.before // ""' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
  if [ -n "$before" ] \
      && [ "$before" != "0000000000000000000000000000000000000000" ] \
      && git cat-file -e "$before" 2>/dev/null; then
    base="$before"
  else
    base=$(git rev-parse --verify HEAD~1 2>/dev/null || true)
  fi
else
  event_base=""
  if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ]; then
    event_base=$(jq -r '.pull_request.base.sha // .merge_group.base_sha // ""' "$GITHUB_EVENT_PATH" 2>/dev/null || true)
  fi
  if [ -n "$event_base" ] && git cat-file -e "${event_base}^{commit}" 2>/dev/null; then
    base="$event_base"
  else
    base=$(git merge-base origin/main HEAD 2>/dev/null || true)
  fi
fi

# Reuse the document the caller computed for this base (AFFECTED). A document is
# usable only when its directory list is an array and it names the same base: one
# computed for another revision describes other changes, so it is ignored and the
# detector runs below. A local run supplies nothing here, and an unreadable
# document fails the same check.
selection=""
if [ -n "${AFFECTED:-}" ] \
    && [ "$(jq -r --arg base "$base" 'if (.dirs | type) == "array" and ((.base // "") == $base) then 1 else 0 end' <<< "$AFFECTED" 2>/dev/null)" = "1" ]; then
  selection="$AFFECTED"
  echo "selection: reusing the affected-workspace document for ${base:-no base revision}" >&2
fi

# One selection pass unless one was supplied. The detector answers with every
# workspace when no base is available, which is the selection the script used
# before.
if [ -z "$selection" ]; then
  selection=$(node scripts/affected-workspaces.mjs "$base") || selection=""
fi

if [ -n "$selection" ]; then
  candidate_dirs=$(jq -r '.dirs[]' <<< "$selection")
else
  # Standalone path for a local run without detector output, for example when
  # the root dependencies are not installed. The selection is unknown, so cover
  # every workspace rather than drop a suite.
  candidate_dirs=$(pnpm ls --json -r --depth -1 2>/dev/null | node -e "
    const pkgs = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    for (const p of pkgs) {
      if (!p.path) continue;
      const rel = require('path').relative(process.cwd(), p.path);
      if (rel && rel !== '.') console.log(rel);
    }
  ")
  echo "warning: workspace detection produced no selection; selecting every workspace with tests" >&2
fi

# --include dirs join the selection before the filter, as they did when the
# script appended them to the dependent-dirs file.
all_dirs="$candidate_dirs"
for dir in ${includes[@]+"${includes[@]}"}; do
  all_dirs+=$'\n'"$dir"
done

# Drop excluded dirs and duplicates; --include dirs join before this filter.
kept_dirs=()
in_list() {
  local needle="$1" dir
  for dir in ${kept_dirs[@]+"${kept_dirs[@]}"}; do
    if [[ "$dir" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

while IFS= read -r dir; do
  [ -n "$dir" ] || continue
  in_list "$dir" && continue

  # Skip excluded dirs
  skip=false
  for ex in "${excludes[@]+"${excludes[@]}"}"; do
    if [[ "$dir" == "$ex" || "$dir" == "$ex/"* ]]; then
      skip=true
      break
    fi
  done
  $skip && continue

  kept_dirs+=("$dir")
done <<< "$all_dirs"

# Read the surviving manifests in one Node invocation: the workspace name and
# its test script decide the row without a process per workspace.
entries=$(printf '%s\n' ${kept_dirs[@]+"${kept_dirs[@]}"} | node -e '
  const fs = require("fs");
  const lines = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const dir of lines) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(`${dir}/package.json`, "utf8"));
    } catch {
      continue;
    }
    if (!manifest.name || !manifest.scripts?.test) continue;
    console.log(`${manifest.name}\t${dir}`);
  }
')

# Keep a row only when the workspace's test script has a test file to run.
# `-print -quit` stops find after the first match and prints it, avoiding
# a `find | head -1` pipeline — on Linux that produces SIGPIPE on find,
# which under `set -o pipefail` propagates as a non-zero pipeline exit.
# The prune form skips real files under node_modules instead of only
# filtering them out of the result.
rows=""
while IFS=$'\t' read -r name dir; do
  [ -n "$dir" ] || continue
  test_file=$(find "$dir" -path '*/node_modules' -prune -o -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.js' -o -name '*.test.jsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.spec.js' -o -name '*.spec.jsx' \) -print -quit 2>/dev/null)
  [ -n "$test_file" ] || continue
  rows+="${name}"$'\t'"${dir}"$'\n'
done <<< "$entries"

# Serialize all entries to JSON in a single node invocation (avoids shell interpolation issues)
if [ -z "$rows" ]; then
  echo "[]"
else
  echo -n "$rows" | node -e "
    const lines = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n');
    const matrix = lines.map(line => {
      const [name, dir] = line.split('\t');
      return { name, dir };
    });
    console.log(JSON.stringify(matrix));
  "
fi
