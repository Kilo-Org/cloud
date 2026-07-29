#!/usr/bin/env bash
# Create everything a new section needs, per .kilo_workflow/WORKFLOW.md Ground
# Rules — run id, worktrees, cloud preparation, scratch directory — so no
# starter or planner hand-assembles the ritual (and none can reuse a stale
# branch, skip the cloud worktree, or put scratch inside a repository).
#
#   init-section.sh <name> [sibling-repo-path...]
#
#   name     lowercase slug WITHOUT the run id, e.g. `billing`; the script
#            appends `-<4 hex>` itself
#   sibling  optional absolute path(s) to sibling repositories the plan
#            touches (e.g. ~/Projects/kilocode); each gets its own worktree
#            on the same branch. The cloud worktree is always created.
#
# Prints a manifest, one `key=value` per line: section, cloud worktree,
# scratch, and one line per sibling worktree. Sibling repositories follow
# their own AGENTS.md setup afterwards (kilocode uses bun, not pnpm).
set -euo pipefail

NAME=${1:?usage: init-section.sh <name> [sibling-repo-path...]}
shift
[[ "$NAME" =~ ^[a-z0-9-]+$ ]] || { echo "init-section: name must be a lowercase slug ([a-z0-9-]): '$NAME'" >&2; exit 1; }
[[ "$NAME" =~ -[0-9a-f]{4}$ ]] && { echo "init-section: pass the bare name — the run id is appended here" >&2; exit 1; }

CLOUD_REPO=$(cd "$(dirname "$0")/.." && pwd -P)
WT_ROOT="$HOME/Projects/.worktrees"
mkdir -p "$WT_ROOT"

SECTION="$NAME-$(openssl rand -hex 2)"

add_worktree() {
  local repo=$1 path=$2
  git -C "$repo" fetch origin
  git -C "$repo" worktree add "$path" -b "$SECTION" origin/main
}

CLOUD_WT="$WT_ROOT/$SECTION"
add_worktree "$CLOUD_REPO" "$CLOUD_WT"
(cd "$CLOUD_WT" && pnpm dev:worktree:prepare)

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/kilo-workflow-$SECTION.XXXXXX")

echo "section=$SECTION"
echo "cloud_worktree=$CLOUD_WT"
echo "scratch=$SCRATCH"
for repo in "$@"; do
  [ -d "$repo/.git" ] || [ -f "$repo/.git" ] || { echo "init-section: not a git repository: $repo" >&2; exit 1; }
  SIB_WT="$WT_ROOT/$SECTION-$(basename "$repo")"
  add_worktree "$repo" "$SIB_WT"
  echo "sibling_worktree=$SIB_WT"
done
