#!/usr/bin/env bash
# Check the mechanical half of the completion gate for one PR, per
# .kilo_workflow/WORKFLOW.md. Assembling these facts by hand invites two
# classic false passes: an approving Kilobot comment from an OLDER head, and
# a green `Kilo Code Review` check read as a verdict. Judgment items — does
# the comment actually approve, are the screenshots real — stay with the
# agent; this script pins the facts to one head SHA.
#
#   pr-gate.sh <owner/repo> <pr>
#
# Prints the facts, then `GATE FAIL: ...` lines for every mechanical item
# that does not hold (exit 1), or `GATE OK (mechanical items)` (exit 0).
# Kilobot comments are printed only when they postdate the head commit —
# read the newest one's verdict yourself; wording drifts, never string-match.
set -euo pipefail

REPO=${1:?owner/repo} PR=${2:?pr number}
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "repository must be owner/repo" >&2; exit 1; }

DATA=$(gh pr view "$PR" --repo "$REPO" \
  --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup,assignees,labels,comments)

HEAD_OID=$(jq -r '.headRefOid' <<<"$DATA")
HEAD_TIME=$(gh api "repos/$REPO/commits/$HEAD_OID" --jq '.commit.committer.date')

echo "head=$HEAD_OID ($HEAD_TIME)"
echo "mergeable=$(jq -r '.mergeable' <<<"$DATA") mergeStateStatus=$(jq -r '.mergeStateStatus' <<<"$DATA")"
echo "assignees=$(jq -r '[.assignees[].login] | join(",")' <<<"$DATA")"
echo "labels=$(jq -r '[.labels[].name] | join(",")' <<<"$DATA")"

BAD_CHECKS=$(jq -r '[.statusCheckRollup[]? | select((.conclusion // .state // "PENDING") as $c
  | ($c | ascii_upcase) as $u
  | ($u == "SUCCESS" or $u == "NEUTRAL" or $u == "SKIPPED") | not)
  | "\(.name // .context): \(.conclusion // .state // "PENDING")"] | .[]' <<<"$DATA")
[ -n "$BAD_CHECKS" ] && { echo "checks not green:"; sed 's/^/  /' <<<"$BAD_CHECKS"; } || echo "checks: all green"

UNRESOLVED=$("$(dirname "$0")/pr-threads.sh" unresolved "$REPO" "$PR" | grep -c . || true)
echo "unresolved_threads=$UNRESOLVED"

KILOBOT=$(jq -r --arg t "$HEAD_TIME" \
  '[.comments[] | select((.author.login | test("bot"; "i")) and .createdAt > $t)
    | "\(.author.login) @ \(.createdAt): \(.body | gsub("\\s+"; " ") | .[0:200])"] | .[]' <<<"$DATA")
if [ -n "$KILOBOT" ]; then
  echo "bot comments after head commit:"
  sed 's/^/  /' <<<"$KILOBOT"
else
  echo "bot comments after head commit: NONE"
fi

FAIL=0
gate_fail() { echo "GATE FAIL: $1"; FAIL=1; }
MERGEABLE=$(jq -r '.mergeable' <<<"$DATA")
case $MERGEABLE in
  MERGEABLE) ;;
  UNKNOWN) gate_fail "mergeability UNKNOWN — GitHub is still recomputing it; re-run in ~30s" ;;
  *) gate_fail "not mergeable ($MERGEABLE — resolve conflicts by merging origin/main)" ;;
esac
[ -z "$BAD_CHECKS" ] || gate_fail "CI checks not green on head"
[ "$UNRESOLVED" -eq 0 ] || gate_fail "$UNRESOLVED unresolved review thread(s)"
[ "$(jq -r '.assignees | length' <<<"$DATA")" -gt 0 ] || gate_fail "no assignee"
[ -n "$KILOBOT" ] || gate_fail "no bot summary comment postdating the head commit (wait, retrigger, or waive per the Kilobot loop)"
[ "$FAIL" -eq 0 ] && echo "GATE OK (mechanical items — verdict wording, screenshots, and learnings are still yours to judge)"
exit "$FAIL"
