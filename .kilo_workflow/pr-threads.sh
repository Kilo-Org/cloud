#!/usr/bin/env bash
# PR review-thread plumbing for the Kilobot loop, per .kilo_workflow/WORKFLOW.md.
# Thread grouping, isResolved, and resolution live only in GitHub's GraphQL API;
# the REST comments endpoint cannot express any of them, and hand-assembled
# GraphQL burns rounds on quoting and pagination mistakes.
#
#   pr-threads.sh list <owner/repo> <pr>                 # every thread: id, state, path, comments, first-comment id/author/body
#   pr-threads.sh unresolved <owner/repo> <pr>           # just the unresolved ones (empty output = clean)
#   pr-threads.sh close <owner/repo> <thread-id> <body>  # reply in-thread AND resolve it, asserting both
#   pr-threads.sh reply <owner/repo> <thread-id> <body>  # reply only (e.g. while more work is coming)
#   pr-threads.sh resolve <owner/repo> <thread-id>       # resolve only
#
# <body> may be `-` to read stdin. Replies get the mandatory "(bot) " prefix
# added when missing. A fix without its in-thread reply and resolution is not
# done — `close` is the normal move.
set -euo pipefail

CMD=${1:?usage: pr-threads.sh list|unresolved|close|reply|resolve ...}
REPO=${2:?owner/repo}
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "repository must be owner/repo" >&2; exit 1; }
OWNER=${REPO%%/*}
NAME=${REPO##*/}

QUERY='query($owner:String!,$repo:String!,$pr:Int!,$after:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$pr){
    reviewThreads(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{id isResolved isOutdated path line
        comments(first:1){totalCount nodes{databaseId author{login} body}}}}}}}'

# Emits every thread node, cursor-paginated — thread 101 must not silently
# vanish from a "clean" verdict.
threads() {
  local pr=$1 after="" page
  while :; do
    page=$(gh api graphql -f query="$QUERY" -f owner="$OWNER" -f repo="$NAME" -F pr="$pr" \
      ${after:+-f after="$after"} --jq '.data.repository.pullRequest.reviewThreads')
    jq -c '.nodes[]' <<<"$page"
    [ "$(jq -r '.pageInfo.hasNextPage' <<<"$page")" = "true" ] || break
    after=$(jq -r '.pageInfo.endCursor' <<<"$page")
  done
}

render() {
  jq -r '[.id, (if .isResolved then "resolved" else "UNRESOLVED" end),
          "\(.path // "-"):\(.line // "-")",
          (.comments.totalCount | tostring),
          (.comments.nodes[0].databaseId | tostring),
          (.comments.nodes[0].author.login // "?"),
          (.comments.nodes[0].body | gsub("\\s+"; " ") | .[0:160])] | @tsv'
}

read_body() {
  local body=$1
  [ "$body" = "-" ] && body=$(cat)
  case $body in "(bot) "*) ;; *) body="(bot) $body" ;; esac
  printf '%s' "$body"
}

# One lookup answers everything about a thread: its repository (verified
# against the caller's, so a global node id cannot cross repositories), its PR
# number (for the REST reply URL), its first top-level comment id (the only
# valid REST reply target), and its existing comment bodies (so a retried
# `close` never posts the same reply twice).
thread_info() {
  gh api graphql -f query='query($id:ID!){node(id:$id){
    ... on PullRequestReviewThread{
      pullRequest{number}
      repository{nameWithOwner}
      comments(first:100){nodes{databaseId body}}}}}' -f id="$1"
}

do_reply() {
  local thread=$1 body=$2 info repo pr comment
  info=$(thread_info "$thread")
  repo=$(jq -r '.data.node.repository.nameWithOwner' <<<"$info")
  [ "$repo" = "$REPO" ] || { echo "pr-threads: thread $thread belongs to $repo, not $REPO" >&2; exit 1; }
  pr=$(jq -r '.data.node.pullRequest.number' <<<"$info")
  comment=$(jq -r '.data.node.comments.nodes[0].databaseId' <<<"$info")
  if jq -e --arg b "$body" '.data.node.comments.nodes[] | select(.body == $b)' <<<"$info" >/dev/null; then
    echo "reply already posted; not repeating it"
    return 0
  fi
  gh api "repos/$REPO/pulls/$pr/comments/$comment/replies" -f body="$body" --jq '.html_url'
}

do_resolve() {
  local thread=$1 resolved
  resolved=$(gh api graphql \
    -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' \
    -f t="$thread" --jq '.data.resolveReviewThread.thread.isResolved')
  [ "$resolved" = "true" ] || { echo "pr-threads: resolve did not stick for $thread" >&2; exit 1; }
  echo "resolved $thread"
}

case $CMD in
  list)
    printf 'thread_id\tstate\tlocation\tcomments\tfirst_comment_id\tauthor\tbody\n'
    threads "${3:?pr number}" | render
    ;;
  unresolved)
    threads "${3:?pr number}" | jq -c 'select(.isResolved | not)' | render
    ;;
  close)
    BODY=$(read_body "${4:?body or -}")
    do_reply "${3:?thread id}" "$BODY"
    do_resolve "$3"
    ;;
  reply)
    BODY=$(read_body "${4:?body or -}")
    do_reply "${3:?thread id}" "$BODY"
    ;;
  resolve)
    do_resolve "${3:?thread id}"
    ;;
  *) echo "usage: pr-threads.sh list|unresolved|close|reply|resolve ..." >&2; exit 1 ;;
esac
