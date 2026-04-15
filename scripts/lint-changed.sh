#!/usr/bin/env bash
set -euo pipefail

PATH="node_modules/.bin:$PATH"

base="${1:-}"
if [ -z "$base" ]; then
  base=$(git merge-base origin/main HEAD 2>/dev/null || true)
fi

if [ -z "$base" ]; then
  echo "[lint] no merge base found, skipping changed-file lint"
  exit 0
fi

root_lint_files=$(git diff --name-only "$base" --diff-filter=ACMR -- \
  '*.js' \
  '*.jsx' \
  '*.ts' \
  '*.tsx' \
  ':!apps/mobile/**' \
  || true)

mobile_lint_files=$(git diff --name-only "$base" --diff-filter=ACMR -- \
  'apps/mobile/**/*.js' \
  'apps/mobile/**/*.jsx' \
  'apps/mobile/**/*.ts' \
  'apps/mobile/**/*.tsx' \
  || true)

if [ -n "$root_lint_files" ]; then
  printf '%s\n' "$root_lint_files" | xargs oxlint --config .oxlintrc.json
else
  echo "[lint] no changed root JS/TS files"
fi

if [ -n "$mobile_lint_files" ]; then
  printf '%s\n' "$mobile_lint_files" | xargs oxlint --config apps/mobile/.oxlintrc.json
else
  echo "[lint] no changed mobile JS/TS files"
fi
