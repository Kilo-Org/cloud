#!/usr/bin/env bash
set -euo pipefail

# Format the files this branch changes against origin/main.
#
# The diff base, the changed-file list and the glob set it is drawn from live
# here once, so the root `format:changed` script and the package-level scripts
# that run from a package directory format the same files: the repository root
# is resolved first and the diff is taken over the whole repository. `--check`
# selects listing instead of formatting.
#
# Usage:
#   scripts/format-changed.sh          # rewrite changed files with oxfmt
#   scripts/format-changed.sh --check  # list changed files that oxfmt would rewrite

cd "$(git rev-parse --show-toplevel)"

PATH="node_modules/.bin:$PATH"

check=false
for arg in "$@"; do
  case "$arg" in
    --check) check=true ;;
    *)
      echo "[format] unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

base=$(git merge-base origin/main HEAD 2>/dev/null || true)

if [ -z "$base" ]; then
  echo "[format] no merge base against origin/main, skipping changed-file formatting"
  exit 0
fi

changed=$(git diff --name-only "$base" --diff-filter=ACMR -- \
  '**/*.js' \
  '**/*.jsx' \
  '**/*.ts' \
  '**/*.tsx' \
  '**/*.json' \
  '**/*.css' \
  '**/*.md')

if [ -z "$changed" ]; then
  echo "[format] no changed files to format"
  exit 0
fi

if [ "$check" = true ]; then
  printf '%s\n' "$changed" | xargs -r oxfmt --list-different --no-error-on-unmatched-pattern
else
  printf '%s\n' "$changed" | xargs -r oxfmt --no-error-on-unmatched-pattern
fi
