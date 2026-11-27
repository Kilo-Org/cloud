#!/usr/bin/env bash
set -euo pipefail

# Audit GitHub Actions workflows with zizmor (https://docs.zizmor.sh).
# zizmor is a Rust binary published on PyPI, not npm, so it runs through uv from
# the lockfile in tools/zizmor rather than as a package.json dependency.
# Dependabot's uv ecosystem updates that pyproject.toml and uv.lock.
#
# Usage:
#   scripts/zizmor.sh [zizmor flags] [-- paths...]
#
#   scripts/zizmor.sh                                  # every workflow and composite action
#   scripts/zizmor.sh -- .github/workflows/ci.yml      # one workflow
#   scripts/zizmor.sh --pedantic                       # extra flags go to zizmor
#   scripts/zizmor.sh --config zizmor.yml -- .github   # flag values may be paths
#
# Everything before `--` is passed to zizmor as flags. Everything after `--` is an
# audit input; with none, .github is audited. uv runs with --locked, so the script
# fails if tools/zizmor/uv.lock is out of date with tools/zizmor/pyproject.toml.
# Fix it with: uv lock --project tools/zizmor
#
# Online audits (impostor commits, known-vulnerable actions, ref confusion) need
# a GitHub token. GH_TOKEN or `gh auth token` is used when available; otherwise
# the run is offline and says so.

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required (https://docs.astral.sh/uv/getting-started/installation/)" >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

args=()
inputs=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    inputs=("$@")
    break
  fi
  args+=("$1")
  shift
done

if [ "${#inputs[@]}" -eq 0 ]; then
  inputs=(.github)
fi

offline=false
for arg in ${args[@]+"${args[@]}"}; do
  [ "$arg" = "--offline" ] && offline=true
done

[ -n "${GH_TOKEN:-}" ] || unset GH_TOKEN
[ -n "${GITHUB_TOKEN:-}" ] || unset GITHUB_TOKEN

if [ "$offline" = false ]; then
  if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
    gh_token="$(gh auth token 2>/dev/null || true)"
    [ -z "$gh_token" ] || export GH_TOKEN="$gh_token"
  fi
  if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ]; then
    echo "No GitHub token found; running offline. Online audits are skipped." >&2
    args+=("--offline")
  fi
fi

exec uv run --quiet --locked --no-dev --project tools/zizmor zizmor ${args[@]+"${args[@]}"} "${inputs[@]}"
