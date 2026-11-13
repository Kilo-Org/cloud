# PR maintenance GitHub configuration

## GitHub App subscriptions

The repository does not contain a GitHub App registration manifest. An App administrator must configure both production Apps:

- Standard App (`kiloconnect`).
- Lite App (`kiloconnect-lite`).

Both Apps need these subscriptions:

| Event | Use |
|---|---|
| `pull_request` | Head, target, closure, and merge changes |
| `pull_request_review` | Submitted or edited review bodies |
| `pull_request_review_comment` | Inline feedback, edits, and deletions |
| `pull_request_review_thread` | Resolved or unresolved threads |
| `issue_comment` | PR conversation feedback, edits, and deletions |
| `check_run` | Check results |
| `status` | Commit status results |
| `push` | Branch identity and base file overlap |

Keep pull requests read/write, issues read/write, checks read, actions read, and contents read/write permissions.
GitHub Actions logs require the Actions read permission. Some logs also require approval or have expired.
The development App needs the same subscriptions for local or staging verification.
This change does not modify App configuration or deploy any service.

Configured bot logins require GitHub actor type `Bot`.
Machine-user accounts need `OWNER`, `MEMBER`, or `COLLABORATOR` association instead.
Kilo summary fingerprints exclude previous-review history, usage footers, status headers, and generated Fix Link sections.
Actual findings and code examples remain actionable. Unknown conversation text still goes to the maintenance agent.

## Observation and API ownership

Signed webhook admission waits for the observation transaction. Failed persistence returns HTTP 503.
Each watch records delivery receipts with its generation. Duplicate deliveries do not advance the pending revision.
The initial assessment and Recheck share `claimPrRefresh` and `fetchPullRequestObservations` with the existing PR refresh.
Review text, conversation comments, and changed files use the existing GraphQL request.
Incomplete pages remain incomplete. They do not prove that all checks passed or all threads resolved.
Initial assessment includes bounded inline follow-up comments, not only thread roots.
New inline feedback can require one repair-tied query to obtain its thread ID and any missing trusted root.
The backend does not poll GitHub for this metadata.

Version 2 maintenance watches have no expiry. Legacy version 1 observation consent keeps its original time limit.

The observer saves `pending_since` and `next_run_at`. The runtime owns durable timers.
Dispatch reconciles live attempts first. Eligible idle watches use `processWatchPrConflictBatch` once per installation.
Waiting for user activity reads Kilo state only. It does not poll GitHub.

Base pushes without file overlap schedule no GitHub call. Incomplete file lists remain conservative.
Renames keep the overlap result uncertain because GraphQL does not return the previous filename.
Conflict queries contain at most 25 PR aliases. Alias errors do not discard other PR results.
An installation-scoped claim admits one conflict batch per minute across concurrent dispatches.
Each PR has a 15-minute conflict-check interval, with one delayed retry for an unknown result.
Unknown results after that retry require new webhook evidence or Recheck. They do not start a polling loop.
When a repair is already queued, the agent inspects conflicts with Git instead of making another API request.

All maintenance requests check the installation cooldown. Low remaining budget defers maintenance until reset.
Writes use an installation lease and a one-second cooldown after completion. No web request sleeps.
The backend persists the returned retry time and schedules another dispatch.

Replies record an intent before GitHub publication. Each reply contains the shared hidden marker and a deterministic reply marker.
An unknown write reconciles against recent GitHub comments twice. It never blindly posts the same reply again.
The backend surfaces unresolved publication outcomes as recoverable blockers.
Thread resolution batches verified addressed feedback in one GraphQL mutation. Repeating resolution is idempotent.
Reply receipts use the attempt generation, not a later resumed watch generation.
Current access, consent, watch status, and PR identity still gate each write. Stop and stopped attempts cancel queued writes.
Reply receipts remain while the watch is live or paused. Ordinary activity keeps its separate 30-day retention.
The finished-watch retention and deletion cascades still remove private maintenance data.
Known rate-limited log reads retain a retry time and can resume after cooldown. Unknown read outcomes remain unknown.

## Telemetry

Structured server records named `github_pr_maintenance_api` contain installation, App, endpoint class, reason, call count, and remaining budget.
GraphQL reads also record the actual `rateLimit.cost`. Records never include tokens, comment text, or job logs.
Sum `calls`, not record count. Request records count one call; response records attach budget and cost with zero additional calls.
Agent-side token-broker measurement belongs to the runtime integration.
