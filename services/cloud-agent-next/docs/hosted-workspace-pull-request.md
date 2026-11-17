# Hosted workspace pull-request status

`listHostedWorkspaces` and `getHostedWorkspace` include one `pullRequest` value
per workspace. It is a passive projection of the existing verified-link and
webhook cache tables; the read never opens a sandbox, starts compute, or calls
GitHub.

## Selection

A workspace is the checkout. Every root session in the workspace shares that
repository and branch, so the PR is selected once per workspace rather than per
session. The candidate set is:

- the PR cached for the workspace's `git_url`/`git_branch`, or
- a PR a root session verifiably linked (`pr_link_verified_at` is set).

Unverified links and deleted links are not candidates. There is no branch-name
lookup. Ordering is open/draft first, then the workspace-branch PR, then the
newest PR number, so the result is stable regardless of which root session the
IDE displays. Two workspaces for the same repository remain separate because the
read is keyed by workspace ID.

## Meaning of an empty result

`pullRequest: null` means no verified PR is known for the workspace. An owner
without a GitHub integration has no source for link verification or cache
population, so no PR data is returned. A failed read or refresh is an error or
an explicit refresh status, never a silent `null`.

## Freshness and partial evidence

`lastSyncedAt` is when the cache row was last written. Cached values can be older
than that timestamp and older than GitHub's current state; webhooks can lag and
the cache is not a live GitHub read.

Checks and mergeability are only reported when the stored observation belongs to
the PR's current head SHA. A stale head, a truncated observation, unavailable
evidence, or a pending review decision sets `partial: true` and the relevant
`complete`/`available` flag to `false`. A PR with no checks reports total `0`
with `available: true` and `complete: true`; it is never rendered as passed.
Consumers must keep the last known values when `partial` is true.

## Explicit refresh

`refreshHostedWorkspacePullRequest({ workspaceId })` reuses the existing
`cliSessionsV2.refreshAssociatedPullRequest` path in Cloud web, including its
link verification, throttle, GitHub rate-limit cooldown, and per-PR refresh
budget. The workspace refresh reports:

| Status | Meaning |
|---|---|
| `refreshed` | A verified/cached PR is available after the refresh |
| `no_pr` | No verified PR exists for the workspace |
| `no_integration` | The workspace owner/org has no GitHub integration |
| `rate_limited` | GitHub is rate limited; `retryAt` is the cooldown |
| `throttled` | A refresh was already attempted; `retryAt` is the cooldown |
| `unavailable` | The refresh path is unavailable; cached data is unchanged |
| `failed` | The GitHub or internal request failed; cached data is unchanged |

The response always includes the current cached `pullRequest` (or `null`) plus
this status. A consumer must not treat `failed`, `unavailable`, `rate_limited`,
`throttled`, or `no_integration` as "no PR."