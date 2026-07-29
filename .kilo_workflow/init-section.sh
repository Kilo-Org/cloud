#!/usr/bin/env bash
# Create a section's run id, worktrees, prepared cloud checkout, and scratch
# directory. `add-repo` adds a repository discovered during planning.
set -euo pipefail

CLOUD_REPO=$(cd "$(dirname "$0")/.." && pwd -P)
WT_ROOT="$HOME/Projects/.worktrees"
mkdir -p "$WT_ROOT"

CREATED_REPOS=()
CREATED_PATHS=()
SCRATCH=""
SUCCESS=0
cleanup() {
  [ "$SUCCESS" -eq 1 ] && return
  local i repo path
  [ -z "$SCRATCH" ] || rm -rf "$SCRATCH"
  for ((i=${#CREATED_PATHS[@]} - 1; i >= 0; i--)); do
    repo=${CREATED_REPOS[$i]}
    path=${CREATED_PATHS[$i]}
    git -C "$repo" worktree remove --force "$path" >/dev/null 2>&1 || true
    git -C "$repo" branch -D "$SECTION" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

validate_section() {
  [[ "$1" =~ ^[a-z0-9-]+-[0-9a-f]{4}$ ]] ||
    { echo "init-section: section must be a lowercase slug ending in 4 hex characters: $1" >&2; exit 1; }
}

canonical_repo() {
  local repo=$1
  [ -d "$repo" ] || { echo "init-section: not a directory: $repo" >&2; exit 1; }
  repo=$(cd "$repo" && pwd -P)
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 ||
    { echo "init-section: not a git repository: $repo" >&2; exit 1; }
  printf '%s\n' "$repo"
}

preflight_worktree() {
  local repo=$1 path=$2
  [ ! -e "$path" ] || { echo "init-section: target already exists: $path — remove it (git worktree remove --force $path; git branch -D $SECTION) or it was not created by init-section and cannot be repaired by hand" >&2; exit 1; }
  ! git -C "$repo" show-ref --verify --quiet "refs/heads/$SECTION" ||
    { echo "init-section: branch already exists in $repo: $SECTION — delete it (git branch -D $SECTION) if it is stale" >&2; exit 1; }
}

add_worktree() {
  local repo=$1 path=$2
  git -C "$repo" worktree add "$path" -b "$SECTION" origin/main >&2
  CREATED_REPOS+=("$repo")
  CREATED_PATHS+=("$path")
}

if [ "${1:-}" = "add-repo" ]; then
  SECTION=${2:?usage: init-section.sh add-repo <section> <repo>}
  validate_section "$SECTION"
  REPO=$(canonical_repo "${3:?repository path}")
  TARGET="$WT_ROOT/$SECTION-$(basename "$REPO")"
  preflight_worktree "$REPO" "$TARGET"
  git -C "$REPO" fetch origin >&2
  git -C "$REPO" rev-parse --verify origin/main >/dev/null
  add_worktree "$REPO" "$TARGET"
  echo "sibling_worktree=$TARGET"
  SUCCESS=1
  exit 0
fi

NAME=${1:?usage: init-section.sh <name> [sibling-repo-path...]}
shift
[[ "$NAME" =~ ^[a-z0-9-]+$ ]] ||
  { echo "init-section: name must be a lowercase slug ([a-z0-9-]): '$NAME'" >&2; exit 1; }
[[ "$NAME" =~ -[0-9a-f]{4}$ ]] &&
  { echo "init-section: pass the bare name — the run id is appended here" >&2; exit 1; }
SECTION="$NAME-$(openssl rand -hex 2)"

REPOS=("$CLOUD_REPO")
for repo in "$@"; do REPOS+=("$(canonical_repo "$repo")"); done

PATHS=("$WT_ROOT/$SECTION")
for ((i=1; i<${#REPOS[@]}; i++)); do
  path="$WT_ROOT/$SECTION-$(basename "${REPOS[$i]}")"
  for existing in "${PATHS[@]}"; do
    [ "$existing" != "$path" ] ||
      { echo "init-section: repositories share target basename: $path" >&2; exit 1; }
  done
  PATHS+=("$path")
done

# Validate every repository before the first write; fetches then run before any
# worktree exists, so a bad remote cannot leave a half-created section.
for ((i=0; i<${#REPOS[@]}; i++)); do
  preflight_worktree "${REPOS[$i]}" "${PATHS[$i]}"
done
for repo in "${REPOS[@]}"; do
  git -C "$repo" fetch origin >&2
  git -C "$repo" rev-parse --verify origin/main >/dev/null
done
for ((i=0; i<${#REPOS[@]}; i++)); do
  add_worktree "${REPOS[$i]}" "${PATHS[$i]}"
done

CLOUD_WT=${PATHS[0]}
(cd "$CLOUD_WT" && pnpm dev:worktree:prepare) >&2
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/kilo-workflow-$SECTION.XXXXXX")

echo "section=$SECTION"
echo "cloud_worktree=$CLOUD_WT"
echo "scratch=$SCRATCH"
for ((i=1; i<${#PATHS[@]}; i++)); do echo "sibling_worktree=${PATHS[$i]}"; done
SUCCESS=1
