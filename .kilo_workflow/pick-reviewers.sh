#!/usr/bin/env bash
# Rank reviewer candidates for a PR per .kilo_workflow/WORKFLOW.md "Picking
# Reviewers": who reviewed recent PRs touching the same files, and who reviews
# the requesting human's work. Pure plumbing — the dispatcher just requests the
# top one or two names.
#
#   pick-reviewers.sh <owner/repo> <requesting-handle> <file> [file...]
#
# Run from the repository the files live in (uses git log). Prints
# "<count> <login>" lines, most frequent first, bots and the requesting human
# already dropped. No output at all means no history — request nobody and say
# so in one line in the PR description.
set -euo pipefail

REPO=${1:?owner/repo} HANDLE=${2:?requesting GitHub handle}
shift 2
[ $# -gt 0 ] || { echo "usage: pick-reviewers.sh <owner/repo> <handle> <file>..." >&2; exit 1; }

PRS=$(
  {
    for f in "$@"; do
      git log -10 --format='%H' -- "$f"
    done | sort -u | while read -r sha; do
      gh api "repos/$REPO/commits/$sha/pulls" --jq '.[].number' 2>/dev/null || true
    done
    gh pr list --repo "$REPO" --author "$HANDLE" --state merged --limit 10 \
      --json number --jq '.[].number'
  } | sort -un
)

[ -n "$PRS" ] || exit 0
for n in $PRS; do
  gh pr view "$n" --repo "$REPO" --json reviews --jq '.reviews[].author.login' 2>/dev/null || true
done | grep -viE 'bot' | grep -vxF "$HANDLE" | sort | uniq -c | sort -rn | awk '{print $1, $2}'
