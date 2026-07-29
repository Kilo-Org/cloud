#!/usr/bin/env bash
# PR review-thread plumbing for the Kilobot loop, per .kilo_workflow/WORKFLOW.md.
# Thread grouping, isResolved, and resolution live only in GitHub's GraphQL API;
# the REST comments endpoint cannot express any of them, and hand-assembled
# GraphQL burns rounds on quoting mistakes.
#
#   pr-threads.sh list <owner/repo> <pr>                      # every thread: id, state, path, first-comment id/author/body
#   pr-threads.sh unresolved <owner/repo> <pr>                # just the unresolved ones (empty output = clean)
#   pr-threads.sh reply <owner/repo> <pr> <comment-id> <body> # reply in-thread; body may be - for stdin
#   pr-threads.sh resolve <owner/repo> <thread-id>            # mark the thread resolved
#
# Replies get the mandatory "(bot) " prefix added when missing. The reply
# target is the thread's FIRST comment id (shown by list). A fix without its
# in-thread reply and resolution is not done.
set -euo pipefail

CMD=${1:?usage: pr-threads.sh list|unresolved|reply|resolve ...}
REPO=${2:?owner/repo}
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "repository must be owner/repo" >&2; exit 1; }
OWNER=${REPO%%/*}
NAME=${REPO##*/}

QUERY='query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){pullRequest(number:$pr){
    reviewThreads(first:100){nodes{id isResolved isOutdated path line
      comments(first:1){nodes{databaseId author{login} body}}}}}}}'

threads() {
  gh api graphql -f query="$QUERY" -f owner="$OWNER" -f repo="$NAME" -F pr="${1:?pr number}" \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[]'
}

render() {
  jq -r '[.id, (if .isResolved then "resolved" else "UNRESOLVED" end),
          "\(.path // "-"):\(.line // "-")",
          (.comments.nodes[0].databaseId | tostring),
          (.comments.nodes[0].author.login // "?"),
          (.comments.nodes[0].body | gsub("\\s+"; " ") | .[0:160])] | @tsv'
}

case $CMD in
  list)
    echo -e "thread_id\tstate\tlocation\tfirst_comment_id\tauthor\tbody"
    threads "${3:?pr number}" | render
    ;;
  unresolved)
    threads "${3:?pr number}" | jq -c 'select(.isResolved | not)' | render
    ;;
  reply)
    PR=${3:?pr number} COMMENT=${4:?first-comment id} BODY=${5:?body or -}
    [ "$BODY" = "-" ] && BODY=$(cat)
    case $BODY in "(bot) "*) ;; *) BODY="(bot) $BODY" ;; esac
    gh api "repos/$REPO/pulls/$PR/comments/$COMMENT/replies" -f body="$BODY" --jq '.html_url'
    ;;
  resolve)
    THREAD=${3:?thread id}
    gh api graphql \
      -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' \
      -f t="$THREAD" --jq '.data.resolveReviewThread.thread.isResolved'
    ;;
  *) echo "usage: pr-threads.sh list|unresolved|reply|resolve ..." >&2; exit 1 ;;
esac
