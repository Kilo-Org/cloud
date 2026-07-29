#!/usr/bin/env bash
# Rank reviewer candidates for a PR per .kilo_workflow/WORKFLOW.md "Picking
# Reviewers": who reviewed recent PRs touching the same files, and who reviews
# the requesting human's work. Pure plumbing — the dispatcher just requests the
# top one or two names.
#
#   pick-reviewers.sh <owner/repo> <requesting-handle> <file> [file...]
#
# Run from the repository the files live in (uses git log). Prints
# "<count> <login>" lines, most frequent first — each login counted once per
# PR it reviewed, bots and the requesting human dropped. No output at all
# (exit 0) means no history — request nobody and say so in one line in the PR
# description.
set -euo pipefail

REPO=${1:?owner/repo} HANDLE=${2:?requesting GitHub handle}
shift 2
[ $# -gt 0 ] || { echo "usage: pick-reviewers.sh <owner/repo> <handle> <file>..." >&2; exit 1; }

PRS=$(
  {
    for f in "$@"; do
      git log -10 --format='%H' -- "$f"
    done | sort -u | while read -r sha; do
      # Not every commit has a PR (unpushed or direct-pushed) — that is data,
      # not an error. On failure gh prints the error BODY to stdout, so the
      # output must be discarded with the failure, not passed through.
      if out=$(gh api "repos/$REPO/commits/$sha/pulls" --jq '.[].number' 2>/dev/null); then
        printf '%s\n' "$out"
      fi
    done
    gh pr list --repo "$REPO" --author "$HANDLE" --state merged --limit 10 \
      --json number --jq '.[].number'
  } | sort -un
)

[ -n "$PRS" ] || exit 0
# One vote per login per PR — several review submissions on one PR are still
# one relationship. A failed lookup aborts the run: a half-counted ranking is
# worse than none, and only the filters below may legitimately come up empty.
VOTES=""
for n in $PRS; do
  V=$(gh pr view "$n" --repo "$REPO" --json reviews \
    --jq '[.reviews[].author.login] | unique | .[]') || { echo "pick-reviewers: failed to read reviews of PR #$n" >&2; exit 1; }
  VOTES+="$V"$'\n'
done
# The filters (not the API) may legitimately leave nothing — that is the
# promised empty success, not an error.
printf '%s' "$VOTES" \
  | { grep -viE '(^|[-_/])bot([-_[]|$)|\[bot\]$' || true; } \
  | { grep -vixF -- "$HANDLE" || true; } \
  | { grep . || true; } \
  | sort | uniq -c | sort -rn | awk '{print $1, $2}'
