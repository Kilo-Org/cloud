#!/usr/bin/env bash
# Check the mechanical half of the completion gate for one PR, per
# .kilo_workflow/WORKFLOW.md. Assembling these facts by hand invites two
# classic false passes: an approving Kilobot comment from an OLDER head, and
# a green `Kilo Code Review` check read as a verdict. Judgment items — does
# the comment actually approve, are the screenshots real — stay with the
# agent; this script pins the facts to one head SHA.
#
#   pr-gate.sh <owner/repo> <pr> [--assignee <handle>] [--label <name>] [--wait <sec>]
#
#   --assignee   gate-fail unless this handle is among the assignees
#   --label      gate-fail unless this label is present (monitors: human-ready)
#   --wait       poll every 30s up to this budget for the bot summary (or
#                waiver) to appear before reporting; retriggering stays the
#                orchestrator's move — this only waits
#
# Prints the facts, then `GATE FAIL: ...` lines for every mechanical item
# that does not hold (exit 1), or `GATE OK (mechanical items)` (exit 0).
# Bot comments are printed only when their activity postdates the head commit
# (Kilobot edits its standing summary, so updated_at, not created_at) — read
# the newest one's verdict yourself; wording drifts, never string-match it. A
# `(bot) Kilobot posted no approving summary...` waiver comment posted after
# the head satisfies the bot-summary item per the Kilobot loop's waiver rule.
set -euo pipefail

REPO=${1:?owner/repo} PR=${2:?pr number}
shift 2
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "repository must be owner/repo" >&2; exit 1; }
ASSIGNEE="" LABEL="" BOT="kilo-code-bot" WAIT=0
WAIVER="(bot) Kilobot posted no approving summary on this head after two retriggers"
while [ $# -gt 0 ]; do
  case $1 in
    --assignee) ASSIGNEE=${2:?}; shift 2 ;;
    --label) LABEL=${2:?}; shift 2 ;;
    --wait) WAIT=${2:?}; shift 2 ;;
    *) echo "pr-gate: unknown option $1" >&2; exit 1 ;;
  esac
done

DEADLINE=$(( $(date +%s) + WAIT ))
while :; do
  DATA=$(gh pr view "$PR" --repo "$REPO" \
    --json headRefOid,mergeable,mergeStateStatus,statusCheckRollup,assignees,labels)
  HEAD_OID=$(jq -r '.headRefOid' <<<"$DATA")
  HEAD_TIME=$(gh api "repos/$REPO/commits/$HEAD_OID" --jq '.commit.committer.date')
  # Kilobot EDITS its standing summary comment instead of posting anew, so a
  # createdAt filter never sees later approvals. The REST `since` parameter
  # filters by updated_at — exactly "bot activity postdating the head".
  # REST logins carry the [bot] suffix gh pr view normalizes away.
  COMMENTS=$(gh api "repos/$REPO/issues/$PR/comments?since=$HEAD_TIME&per_page=100&sort=updated&direction=desc")
  BOTCOMMENTS=$(jq -r --arg bot "$BOT" --arg waiver "$WAIVER" \
    '[.[] | select((.user.login == $bot or .user.login == ($bot + "[bot]") or .body == $waiver))
      | "\(.user.login) @ \(.updated_at): \(.body | gsub("\\s+"; " ") | .[0:200])"] | .[]' <<<"$COMMENTS")
  [ -n "$BOTCOMMENTS" ] && break
  [ "$(date +%s)" -ge "$DEADLINE" ] && break
  sleep 30
done

echo "head=$HEAD_OID ($HEAD_TIME)"
echo "mergeable=$(jq -r '.mergeable' <<<"$DATA") mergeStateStatus=$(jq -r '.mergeStateStatus' <<<"$DATA")"
echo "assignees=$(jq -r '[.assignees[].login] | join(",")' <<<"$DATA")"
echo "labels=$(jq -r '[.labels[].name] | join(",")' <<<"$DATA")"

BAD_CHECKS=$(jq -r '[.statusCheckRollup[]? | select((.conclusion // .state // "PENDING") as $c
  | ($c | ascii_upcase) as $u
  | ($u == "SUCCESS" or $u == "NEUTRAL" or $u == "SKIPPED") | not)
  | "\(.name // .context): \(.conclusion // .state // "PENDING")"] | .[]' <<<"$DATA")
CHECK_COUNT=$(jq -r '(.statusCheckRollup // []) | length' <<<"$DATA")
if [ "$CHECK_COUNT" -eq 0 ]; then
  echo "checks: NONE REGISTERED"
elif [ -n "$BAD_CHECKS" ]; then
  echo "checks not green:"
  sed 's/^/  /' <<<"$BAD_CHECKS"
else
  echo "checks: all green"
fi

# Any failure to ENUMERATE threads must fail the gate — a half-paginated
# thread list reading as "0 unresolved" is exactly the false pass to avoid.
THREADS_OK=1
if UNRESOLVED_LIST=$("$(dirname "$0")/pr-threads.sh" unresolved "$REPO" "$PR"); then
  UNRESOLVED=$(grep -c . <<<"$UNRESOLVED_LIST" || true)
else
  THREADS_OK=0
  UNRESOLVED="?"
fi
echo "unresolved_threads=$UNRESOLVED"

if [ -n "$BOTCOMMENTS" ]; then
  echo "bot comments after head commit (read the newest verdict yourself):"
  sed 's/^/  /' <<<"$BOTCOMMENTS"
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
[ "$CHECK_COUNT" -gt 0 ] || gate_fail "no CI checks registered on head — wait for GitHub to enqueue them"
[ "$THREADS_OK" -eq 1 ] || gate_fail "could not enumerate review threads — fix that before trusting any thread count"
[ "$THREADS_OK" -eq 1 ] && [ "$UNRESOLVED" != "0" ] && gate_fail "$UNRESOLVED unresolved review thread(s)"
if [ -n "$ASSIGNEE" ]; then
  jq -e --arg a "$ASSIGNEE" '.assignees[].login | select(. == $a)' <<<"$DATA" >/dev/null \
    || gate_fail "not assigned to $ASSIGNEE"
else
  [ "$(jq -r '.assignees | length' <<<"$DATA")" -gt 0 ] || gate_fail "no assignee"
fi
if [ -n "$LABEL" ]; then
  jq -e --arg l "$LABEL" '.labels[].name | select(. == $l)' <<<"$DATA" >/dev/null \
    || gate_fail "label '$LABEL' missing"
fi
[ -n "$BOTCOMMENTS" ] || gate_fail "no $BOT summary (or waiver) postdating the head commit — wait, retrigger, or waive per the Kilobot loop"
[ "$FAIL" -eq 0 ] && echo "GATE OK (mechanical items — verdict wording, screenshots, and learnings are still yours to judge)"
exit "$FAIL"
