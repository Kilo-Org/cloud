# Reading and resolving PR review threads needs GraphQL, not the REST comments endpoint

Symptom: the Kilobot loop needs "zero unresolved threads", but `gh api repos/<o>/<r>/pulls/<n>/comments` shows inline comments with no resolution state, and there is no REST way to resolve a thread — the loop's exit condition looks unevaluable.

Cause: thread grouping, `isResolved`, and resolution live only in GitHub's GraphQL API.

Fix: list threads with their state:

```bash
gh api graphql -f query='query($owner:String!,$repo:String!,$pr:Int!){
  repository(owner:$owner,name:$repo){pullRequest(number:$pr){
    reviewThreads(first:100){nodes{id isResolved path line
      comments(first:10){nodes{author{login} body}}}}}}}' \
  -f owner=<owner> -f repo=<repo> -F pr=<n>
```

Reply in a thread with the REST reply endpoint (the comment id is the thread's first comment id):

```bash
gh api repos/<owner>/<repo>/pulls/<n>/comments/<comment-id>/replies -f body='(bot) ...'
```

Resolve it with the GraphQL mutation, using the thread `id` from the query above:

```bash
gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -f t=<thread-id>
```
