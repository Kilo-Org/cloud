# Hosted workspace contract fixture (v3)

Versioned request/response examples, procedure list, status enums and stable
error codes for the Cloud workspace-first surface an Agent Manager Session Host
consumes.

| Procedure | Kind | Purpose |
|---|---|---|
| `listHostedWorkspaces` | query | Owner-scoped workspace catalog |
| `getHostedWorkspace` | query | One workspace with its root sessions |
| `getHostedWorkspaceStatus` | query | Passive compute/activity/wake/billing/deletion projection |
| `createHostedWorkspace` | mutation | Create a workspace and its first root |
| `createHostedWorkspaceSession` | mutation | Add a root session to an existing workspace |
| `listHostedWorkspaceProfiles` | query | Personal and organization profiles with default flags |
| `setHostedWorkspacePersonalDefaultProfile` | mutation | Set the caller's personal default profile |
| `clearHostedWorkspacePersonalDefaultProfile` | mutation | Clear the caller's personal default profile |
| `deleteHostedWorkspaceSession` | mutation | Delete one non-final root session |
| `deleteWorktree` | mutation | Destructively delete the workspace and every remaining root |
| `getHostedWorkspaceChanges` | query | Workspace-scoped committed/uncommitted snapshot with per-file availability |
| `refreshHostedWorkspaceChanges` | mutation | Explicit refresh with `refreshed` / `offline` / `failed` and the previous snapshot |
| `getHostedWorkspaceChangeFile` | query | Revision-fenced patch and matching whole-file content for one path |
| `getHostedWorkspacePullRequest` | query | Verified linked PR identity and bounded file list |
| `getHostedWorkspacePullRequestFile` | query | Exact PR patch for one path, fenced by the PR head |

## Versioning

- `v1.json` is the released contract. It is **append-only**: never change an
  example, field list, enum or error code in place, because a provider pinned to
  v1 would silently change behavior.
- `v2.json` adds the hosted workspace profile listing and personal-default
  mutations while retaining every v1 procedure and shape.
- `v3.json` is the current contract. It adds the workspace-scoped change reads
  and the verified linked-PR reads. Every v1/v2 procedure and shape is retained;
  the fixture test also asserts that each released version stays an append-only
  subset of the registered router.
- Further breaking or additive contract changes create a new fixture plus a new
  `contractVersion`, and the README documents the difference.
- `test/unit/hosted-workspace-contract-fixture.test.ts` fails when a fixture
  field list, enum, error code, procedure registration or deletion-manifest
  version drifts from the handler schemas. That failure is the signal to add a
  new version, not to edit an existing one.
- `deletionManifestVersion` is the `cloudAgentWorktreeDeletionManifestSchema`
  version stored on a completed workspace tombstone.

## Workspace change and linked-PR authority

The change reads are workspace-keyed (`worktree_<uuid>`), resolve a canonical
root session, and only read the durable snapshot that is stored once per
`worktreeId`. They never name a caller-chosen session, never prepare a runtime
and never allocate compute: a stopped workspace keeps its saved committed and
uncommitted snapshot readable. A multi-repository snapshot is returned as one
comparison per repository and is never merged into a single union; a file that
cannot be attributed to exactly one repository fails closed as `inconsistent`.
Every listed file carries explicit diff/content availability, so an omitted
payload (`binary`, `unsupported`, `too_large`, `inconsistent`, ...) is never an
empty successful diff. The per-file read keeps the session contract's
`stale`, `no_longer_listed` and `not_captured` outcomes.

The linked-PR leg never accepts a caller-supplied owner, repository or number.
It resolves the workspace's cached branch PR and re-verifies the live PR with
the workspace owner's GitHub App installation: base and head must be the
workspace repository and the head ref must be the workspace branch. A missing
PR is `not_linked`; a repo/head-ref mismatch is `unverified` with no PR data.
When the installation cannot read the PR but a connected user credential would,
the result is the distinct `credential_required`; Cloud never spends the
connected-user credential for these reads. A live head that moved relative to
the webhook cache is normal publication progress (`cacheStale` reports the
difference); a head that moves between live verification and the files fetch
returns `stale` without mixed-revision data. GitHub access, rate-limit and availability failures map to
distinct `github_access_denied`, `github_rate_limited` and `github_unavailable`
results.

## Consumers

- `test/e2e/scenarios-hosted-workspace-contract.ts` asserts the live behavior
  this file describes: authorization, idempotent creation, one sandbox per workspace
  that its sibling chats share, abort isolation, passive no-wake reads, idle shutdown and wake,
  separate repository workspaces, and journaled workspace deletion.
- A future Session Host or generated SDK should pin a version and assert against
  these examples rather than re-deriving shapes from ad-hoc notes.
