# Cloud Agent stacked workspaces and sidebar ordering

**Date**: 2026-11-01
**Status**: Plan, not started
**Scope**: Support stacked branches and pull requests in the Cloud Agent web UI, and rework how the
sidebar orders workspaces. Keep one sandbox per workspace.

## Decisions

| Topic | Decision |
|---|---|
| How a stack starts | From an existing workspace in the sidebar or chat header: "New stacked workspace". No branch picker in `NewSessionPanel`. |
| API input | `baseBranch` is the general primitive. `stackOnWorktreeId` is optional and records the stack link; the server derives `baseBranch` from it. |
| Sandboxes | One sandbox per workspace, as today. A worktree only ever rewrites and pushes its own branch. |
| GitHub | Use GitHub stacked pull requests (generally available 2026-10-06): the Stacks REST API, the `stack` webhook data and the `gh-stack` extension. |
| GitLab and Bitbucket | Phase 0 works because it is plain git. Stack linking and sync after GitHub rewrites are GitHub-only. |
| Restack | Wait for the user's button. Plain git first; the agent only when there is a conflict. |
| Sidebar layout | Optional and personal. Smart folders are presets turned on in a new **Sidebar** tab in the Cloud Agent settings dialog. |
| Ordering | Workspace (worktree) rows: manual by default. Single-session rows (bots, triggers, reviews, mobile or API sessions without a worktree): always by date. |
| Automations folder | Dropped. Non-interactive sessions never become worktrees and are hidden by the default platform filter. |

## Current state

### Workspaces, branches and pull requests

- A sidebar "workspace" is a **worktree**: one checkout, one branch, one sandbox and N chats. It is
  stored in `cloud_agent_worktrees` (`packages/db/src/schema.ts:6374-6411`), which has no branch,
  base, parent or pull request column. Chats are `cli_sessions_v2` rows (`schema.ts:6415-6527`)
  with `git_branch`, `pr_url`, `pr_number`, `pr_head_ref`, `pr_head_sha` and `pr_link_verified_at`.
- Only browser `cloud-agent-web` sessions get a registered worktree
  (`services/cloud-agent-next/src/session/session-registration.ts:591-639`).
  `registerCloudAgentWorktree` inserts the row with `onConflictDoNothing`
  (`services/session-ingest/src/services/worktree-deletion.ts:137-170`).
- **Branch name**: `repository.upstreamBranch ?? kilo/<slug>`
  (`src/session/session-registration-metadata.ts:212`). Sibling chats inherit the branch
  (`src/router/handlers/session-worktree.ts:673-693`, validated at 782 and 793).
- **Checkout** (`wrapper/src/control-plane/prepare.ts:553-653`):
  - An explicit `upstreamBranch` runs `checkout -B <b> origin/<b>`.
  - A working branch reuses the local branch if it exists, otherwise tracks `origin/<b>` if that
    exists, otherwise runs `checkout -b <b>` from HEAD, which is the default branch after clone or
    adoption (`workspace-adoption.ts:33-55`).
- `upstreamBranch` means both "work on this branch" and "diff base"
  (`src/sandbox-session/worktree-changes.ts:92-118`). Setting it makes the Changes panel compare
  the branch with itself.
- The web `NewSessionPanel` never sends a branch. Mobile does, through
  `apps/mobile/src/components/agents/repository-branch-selector.tsx` and
  `cloudAgentNext.listRepositoryBranches`.
- **Auto-commit** (`wrapper/src/auto-commit.ts`):
  - It runs `push` if the branch already tracks a remote branch, otherwise
    `push -u origin <branch>` (line 340).
  - A failed push is non-fatal and reported as "push failed" (350-358).
  - It never force-pushes.
- **Pull requests are opened by the agent** with `gh` or `glab`, and the agent chooses the base.
  - The CLI reports `session_pr_link` to session-ingest
    (`services/session-ingest/src/ingest/metadata.ts:121-146`).
  - The GitHub `pull_request` webhook verifies the link and fills the cache table
    `github_branch_pull_requests` (`schema.ts:6943-6997`), in
    `apps/web/src/lib/integrations/platforms/github/webhook-handlers/upsert-cli-session-pull-requests.ts`.
  - `pull_request.base.ref` is parsed (`webhook-schemas.ts:170-173`) but not stored.
  - An `edited` event that changes the base is not treated as a retarget. The tracked actions are
    listed at lines 42-50.
- **Changes panel**:
  - It diffs `merge-base(HEAD, baseRef)..HEAD`, plus uncommitted changes.
  - `baseRef` defaults to `refs/remotes/origin/HEAD`
    (`wrapper/src/control/worktree-changes.ts:55, 368-419`).
  - The contract already accepts `baseRef` and returns `comparison.mergeBase`
    (`packages/worker-utils/src/cloud-agent-worktree-changes.ts`).
- **Agent instructions**: session metadata supports `appendSystemPrompt`
  (`src/persistence/session-metadata.ts:226`). Profile bundles support `runtimeInstructions`
  (`src/persistence/schemas.ts:286`).

### Sidebar ordering

- **Loading** (`apps/web/src/components/cloud-agent-next/hooks/sidebar-queries.ts`):
  - It loads `cliSessionsV2.list` with `orderBy: 'updated_at'`, `limit: 200`, limited to the last
    5 days (`sidebarUpdatedSince`, lines 18-20).
  - Worktrees filed in folders get an extra query for their latest session.
  - The default platform filter `['cloud-agent']` covers `cloud-agent` and `cloud-agent-web`
    (lines 14, 29-31).
- **Grouping** (`hooks/useSidebarSessions.ts:280-410`):
  - Chats are grouped into worktree rows, and each row sorts by the newest `updated_at` of its
    chats.
  - Running sessions move at most once per minute.
  - Rows are bucketed into Today, Yesterday, three weekdays, then Older.
- **Folders** (`cloud_agent_workspace_folders`, `schema.ts:6341-6372`) are ordered by `position`.
  Inside a folder, worktrees keep date order (`workspace-folders.ts:42-63`).
- **`updated_at` is the wrong key.**
  - It has `$onUpdateFn(now())` (`schema.ts:6467-6470`), so any write to the row bumps it.
  - That includes `markSessionsVerifyingPullRequest`, which re-sets `pr_link_verified_at` on every
    matching `pull_request` webhook even when the link is already verified
    (`upsert-cli-session-pull-requests.ts:186-190`).
  - So a push or a merge on GitHub moves a workspace to the top.
  - A real-activity column, `last_activity_at` (`schema.ts:6458`), exists but the sidebar doesn't
    use it.
- **Preferences**:
  - Sidebar preferences are stored in a per-browser cookie
    (`hooks/useSidebarPreferences.ts:55-61`).
  - The Cloud Agent settings dialog
    (`components/cloud-agent-next/settings/CloudAgentSettingsDialog.tsx`) has General,
    Environments, Profiles and Compute tabs.
  - In an organization those settings are shared, and only owners and admins can change them
    (lines 83-87).

### GitHub stacked pull requests

Sources: [REST API for stacks](https://docs.github.com/en/rest/pulls/stacks),
[APIs and webhooks](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests-apis-and-webhooks),
[CLI reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands),
[GA changelog](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available/).

- **REST API**:
  - `GET/POST /repos/{o}/{r}/stacks`, `GET /stacks/{n}`, `POST /stacks/{n}/add` and
    `POST /stacks/{n}/unstack`.
  - PR numbers are given bottom to top, and each PR's base must equal the head branch of the PR
    below it.
  - Pull request resources carry a `stack` object.
- **Webhooks**: `pull_request` payloads include `stack`, and there is a new `stacked` action.
- **What GitHub does itself**:
  - It retargets a stack automatically when the stack's base branch is deleted.
  - It rebases automatically after a partial merge, and "Rebase stack" keeps approvals and signed
    commits.
  - Merging a PR in the middle of a stack merges the PRs below it, and the PRs above retarget to
    the stack base.
- **No API for "Rebase stack" (checked 2026-11-01).**
  - The REST Stacks API only lists, gets, creates, extends (`/add`) and dissolves (`/unstack`)
    stacks. The GraphQL `stack` and `stackEntry` fields are read-only.
  - "Rebase stack" (a server-side cascading rebase with force-pushes) exists only as a button in
    the PR merge box
    ([managing stacks](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/managing-stacked-pull-requests)).
  - The only other server-side rebase is the automatic one after the bottom PR merges.
  - `PUT /pulls/{n}/update-branch` merges the base into the head. It is not a rebase and doesn't
    know about stacks, so it would break the stack's required linear history.
  - Merging a stacked PR through the API needs the asynchronous merge API
    (`PUT /pulls/{n}/merge-async`).
  - GitHub's docs disagree on whether server-side rebase commits are signed. The GA changelog says
    they are; the managing-stacks page says they are not.
- **Permissions (checked 2026-11-01)**
  ([permissions for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)):
  - The Stacks endpoints fall under the repository permission **"Pull requests"**: write for
    `POST /stacks`, `/add` and `/unstack`; read for `GET`.
  - They accept both installation and user access tokens.
  - No new permission is needed. The standard KiloConnect app already opens PRs with installation
    tokens (`createGitHubPullRequest` in
    `apps/web/src/lib/code-reviews/review-memory/change-request.ts:156`), so it has Pull
    requests: write.
  - The **KiloConnect-Lite** app is read-only (`app-selector.ts:5-10`). Organizations using it can
    read stack data but not link stacks.
  - Inside the sandbox, the git-token containment allows API calls to the session repository's
    `/repos/{o}/{r}/...` paths and `/graphql` (`services/git-token-service/src/index.ts:568-587`).
    So `gh pr create --base` and `gh stack link` for the session repository pass.
- **`gh stack`**:
  - `init/add/submit/rebase` keep their tracking state in the local clone.
  - `gh stack link` links existing PRs into a stack with no local tracking. It is meant for setups
    where another tool manages the branches.
  - Kilo layers live in separate clones, so the local-tracking commands don't fit. Linking does.
- **Sandbox images** ship `gh` 2.102.0 (`services/cloud-agent-next/Dockerfile:17` and siblings;
  2.103.3 in `Dockerfile.containers.runtime-free` and the Vercel snapshot,
  `src/shared/runtime-distribution.ts:6`), which meets the requirement. `gh-stack` is not
  installed.
- **Where `gh` looks for extensions at runtime (checked 2026-11-01).**
  - `gh` keeps extensions in `$XDG_DATA_HOME/gh/extensions`, and there is no separate override for
    that directory.
  - The agent's Kilo process, its shell, terminals and setup commands all get `HOME` and `XDG_*`
    from `buildWorktreeKiloEnvironment` (`wrapper/src/control/worktree-runtime.ts:171-206`):
    `HOME=/home/<sha256(worktree directory)>` (`workspace-home.ts:30-50`) and
    `XDG_DATA_HOME=$HOME/.local/share`.
  - Profile env cannot override `HOME` or `XDG_*` (`src/shared/runtime-environment.ts:59`).
  - So an extension installed at image build time under `/root/.local/share/gh/extensions` is
    **not visible** to the agent.
  - HOME is per worktree directory and starts empty in every new sandbox.
  - A runtime `gh extension install` also fails: containment rejects API calls to repositories
    other than the session's (`repository_mismatch`), and allowlist egress lacks
    `release-assets.githubusercontent.com`.

## Concepts

- **Stack**: an ordered chain of worktrees. Each layer keeps the rule "one worktree = one branch =
  one pull request".
- **Layer**: a worktree whose branch was created from another branch, its base.
- **Root**: the bottom layer. Its base is the trunk, usually the default branch.
- **Base branch**: the branch a layer was created from, and the target of its pull request.
- **Base SHA**: the parent tip that a layer was last created or restacked onto. The deterministic
  restack uses it.
- **Owning worktree**: the only worktree allowed to rewrite or push a given branch.

## Data model

### `cloud_agent_worktrees` (Postgres)

Add these columns, all nullable and additive:

| Column | Type | Notes |
|---|---|---|
| `parent_worktree_id` | `text` references `cloud_agent_worktrees.worktree_id`, `onDelete: 'set null'` | The stack link. Index it. |
| `base_branch` | `text` | Branch this worktree was created from. Null means the default branch. |
| `base_sha` | `text` | Parent tip last created or restacked onto. Resolved by the web router at creation; updated by Sync and Restack results (see "Base SHA"). |
| `sidebar_position` | `text` | Fractional index for manual order within its container. Null means not positioned (see Ordering). |

Constraints:
- The parent must have the same owner (`kilo_user_id` and `organization_id`) and the same
  `git_url`. Check this in the web router and again in `registerCloudAgentWorktree`.
- Stacking on a worktree that is being deleted is not allowed.

### `github_branch_pull_requests` (Postgres)

| Column | Type | Notes |
|---|---|---|
| `pr_base_ref` | `text` | From the webhook `pull_request.base.ref` and from refresh. |
| `stack_number` | `integer` | From the webhook or REST `stack` object. |
| `stack_position` | `integer` | Position in the stack, bottom = 1. |
| `stack_size` | `integer` | |

### `cloud_agent_workspace_folders` (Postgres)

| Column | Type | Notes |
|---|---|---|
| `kind` | `text` not null, default `'manual'` | `'manual'` or `'smart'`, with a check constraint. |
| `smart_preset` | `text` | `'needs_you'`, `'in_review'` or `'done'`. Required when `kind = 'smart'`. Unique per owner scope. |
| `sort_mode` | `text` not null, default `'manual'` | `'manual'`, `'created'` or `'activity'`. |

### `cloud_agent_sidebar_preferences` (new Postgres table)

Personal and stored per scope. It follows the shape of `agent_briefing_context_preferences`
(`schema.ts:11530`):

| Column | Type |
|---|---|
| `kilo_user_id` | `text`, foreign key to users, cascade |
| `organization_id` | `uuid`, nullable, foreign key, cascade |
| `workspace_order` | `text` not null, default `'manual'`: `'manual'`, `'created'` or `'activity'` |
| `created_at`, `updated_at` | timestamps |

Use a unique key on `(kilo_user_id, coalesce(organization_id, ...))`, matching how existing
personal and organization pairs are keyed. The platform and project filters stay in the cookie.

Generate migrations with `pnpm drizzle generate`, following `packages/db/AGENTS.md` and the
`database-migrations` skill. Prefer one migration per shipped phase.

### Session metadata (Cloud Agent Durable Objects)

- Grouped `SessionMetadata`:
  - Add `repository.baseBranch?: string` and `workspace.parentWorktreeId?: string`.
  - Write them only with `metadataSchemaVersion: 2`. Legacy reads stay in
    `parseSessionMetadata`.
- Grouped `SessionMetadata` also gets `repository.baseSha?: string`: the exact commit the new
  working branch starts from.
- Route spec (`src/shared/control-plane-protocol.ts:315-317`): add `baseBranch` (min 1, max 256)
  and `baseSha` (40 or 64 hex characters) next to `branch` and `branchMode`.
- Sibling chats (`createWorktreeChat`) copy `baseBranch` and `parentWorktreeId` from the source
  chat. Forking (`cloud-session-fork.ts`) does not copy them, in the same way it does not copy the
  branch today.

## Phase S0: sorting fix (independent; ship first)

Goal: stop workspaces jumping because of writes that aren't real activity.

1. **New sort key.**
   - Add `orderBy: 'activity'` to `cliSessionsV2.list` and `search`
     (`apps/web/src/routers/cli-sessions-v2-router.ts:1240-1435`), sorting by
     `coalesce(last_activity_at, created_at)`.
   - Use the same expression for the `updatedSince` window.
   - Add an index on `(kilo_user_id, coalesce(last_activity_at, created_at))` using
     `.concurrently()`. `cli_sessions_v2` is large, so follow the long-build exception in
     `packages/db/AGENTS.md`.
2. **Client sort.**
   - `useSidebarSessions` sorts by the same activity time. Add `lastActivityAt` to
     `StoredSession` and `DbSessionV2`, and map it in `dbSessionToStoredSession`.
   - Keep the once-a-minute damping for running sessions.
   - Update the matching sorts in `ChatSidebar.tsx` and `db-session-atoms.ts`.
3. **Stop re-stamping verification.** In `markSessionsVerifyingPullRequest`, only update rows
   where `pr_link_verified_at IS NULL`.
   - A link change already resets the column to null, so this loses nothing.
   - Return `{ kind: 'session' }` when any candidate matched, already verified or newly marked, so
     the cache upsert path doesn't change.
4. **Tests**:
   - Router ordering with production-shaped timestamps.
   - `useSidebarSessions` grouping and sorting.
   - Webhook verification: an already-verified row is not updated, and the result is still
     `session`.

Acceptance: a GitHub push, merge or review on a workspace's PR does not move it in the sidebar. A
new user message or agent progress does.

## Phase 0: stacked workspace from the sidebar (all providers)

### API

Web tRPC `prepareSession`, personal and organization
(`apps/web/src/routers/cloud-agent-next-schemas.ts:359-504`):

```ts
baseBranch?: string            // create the new working branch from origin/<baseBranch>
stackOnWorktreeId?: string     // record the stack link; server derives baseBranch and repository
```

**Validation:**
- `baseBranch` and `upstreamBranch` together are an error.
- `stackOnWorktreeId` and a repository input that differs from the parent's are an error.
- `stackOnWorktreeId` with a `baseBranch` that differs from the parent's branch is an error.

**Resolving `stackOnWorktreeId`** (in the web router, before calling the Worker):
1. Load the worktree, and check that it is owned by the caller's scope and not being deleted.
2. Resolve the parent's branch from its chats' runtime metadata (`getSession` returns
   `branchName`). Don't trust `git_branch` alone, because it can be stale if the agent switched
   branches.
3. Copy the parent's repository input (GitHub repo with integration id, GitLab project, or
   Bitbucket repo).
4. Resolve the head SHA of the base branch on the remote (see "Preflight and base SHA"). This
   applies to every `baseBranch`, with or without `stackOnWorktreeId`.
5. Pass `baseBranch`, `baseSha` and `parentWorktreeId` to the Worker.

`baseSha` is not a client input. The web router always resolves it, so the client cannot pin an
arbitrary commit.

**Worker**:
- Accept the same fields on flat `prepareSession` and on grouped `start`
  (`src/router/schemas.ts:429-587, 832-855`).
- Adapt them at the boundary into grouped metadata.
- Pass `parentWorktreeId`, `baseBranch` and `baseSha` through to session-ingest registration.

### Branch creation in the wrapper

In `checkoutWorkspace` (`wrapper/src/control-plane/prepare.ts:593-637`), when creating a new
working branch (no local branch and no `origin/<branch>`) and `spec.baseBranch` is set:

```
git fetch origin <baseBranch>                              # managed auth args as today
git merge-base --is-ancestor <baseSha> origin/<baseBranch> # baseSha must still be on the branch
git checkout --progress -b <branch> --no-track <baseSha>
```

- **The branch starts exactly at `baseSha`.** That is the commit the web router resolved and
  recorded, so the recorded `base_sha` is true by construction.
  - If the parent got new commits between prepare and checkout, `baseSha` is still an ancestor.
    The layer starts at `baseSha` and the UI shows "Behind parent".
  - If the parent was force-pushed in between, `baseSha` is no longer on the branch. Fail with
    subtype `base_branch_changed` and the message "Base branch `<x>` changed while the workspace
    was starting; try again". A retry re-resolves the SHA.

- **`--no-track` is required.** Without it, git makes the new branch track `origin/<baseBranch>`.
  Auto-commit would then see a tracked branch and run a plain `push`, which fails or targets the
  wrong branch (`auto-commit.ts:240, 340`). With `--no-track`, the first auto-commit runs
  `push -u origin <branch>` as it does today.
- **Missing base.** If `origin/<baseBranch>` doesn't exist after the fetch, fail with a new
  `WrapperBootstrapError` subtype `base_branch_missing` and the message "Base branch `<x>` has not
  been pushed". Mark it not retryable; a retry can't fix it.
- **Restore is unchanged.** If the worktree's own branch already exists locally or on the remote,
  keep the existing restore path. The spec rule "Rebuilt worktrees MUST restore their pushed
  working branch" still holds.
- **Both checkout paths.** Mirror this in `wrapper/src/session-bootstrap.ts:509-574` if that path
  can still run for these sessions.

### Preflight and base SHA

One provider call answers both "is the base branch pushed?" and "which commit does it point to?".

- **New helper.** Add `getProviderBranchHead({ platform, repository, branch, credentials })` next
  to `listProviderRepositoryBranches` (`apps/web/src/lib/cloud-agent/provider-branch-listing.ts`).
  It returns `{ sha } | { missing: true }`.
  - GitHub: `GET /repos/{o}/{r}/branches/{branch}`, `commit.sha`.
  - GitLab: `GET /projects/:id/repository/branches/:branch`, `commit.id`.
  - Bitbucket (organizations only, as with branch listing today):
    `GET /repositories/{ws}/{slug}/refs/branches/{name}`, `target.hash`.
  - The existing listing returns names only and can be truncated, so it can't be reused.
- **Credentials.** Use the same integration and credentials that `prepareSession` already resolves
  for the repository.
- **Missing branch.** Return a specific error before the session is created: "Base branch `<x>`
  has not been pushed". The wrapper checks stay as the backstop.
- **Why not have the wrapper report the SHA after checkout?**
  - No message from the wrapper carries git data back today.
  - `session.ready` is a strict schema, and the Sandbox DO drops frames that don't match it
    (`sandbox-do.ts:4845-4846`). Adding a field means coordinated Worker-then-wrapper deploys.
  - The Session DO has no session-ingest client to write Postgres.
  - Resolving the SHA up front avoids a new channel, and the preflight needs the provider call
    anyway.

### User experience
- **Menu item.** "New stacked workspace" appears on the worktree row menu (`ChatSidebar.tsx`) and
  the chat header menu (`ChatHeader.tsx`).
  - It is disabled with a tooltip when the parent branch isn't pushed: "Push `feat-a` first; it
    will be pushed after the next successful turn, or enable auto-commit".
  - It is also disabled when the worktree is being deleted.
- **Composer.** The action opens the existing new-session composer with the repository locked and
  a chip reading "Stacked on `feat-a` (#12)". The chip can be removed, which falls back to a
  normal new session.
- **Agent instruction.** Add a short instruction through `appendSystemPrompt` or a named runtime
  instruction: "This workspace is stacked on `<base>`. Open pull requests with `--base <base>`. Do
  not rebase or push branches other than `<branch>`."

### Persistence

- Extend `CreateSessionForCloudAgentParams`
  (`packages/session-ingest-contracts/src/rpc-contract.ts`) with `parentWorktreeId`, `baseBranch`
  and `baseSha`.
- Registration runs in the Worker before any sandbox exists
  (`src/session/session-registration.ts:951-968`), so the values are known at that point.
- `registerCloudAgentWorktree` writes them on the first insert. Later sibling registrations don't
  overwrite them, because of `onConflictDoNothing`.
- Re-check that the parent has the same owner and `git_url` inside the insert transaction.

### Changes panel

- `getWorktreeChanges` and `refreshWorktreeChanges` send `baseRef = refs/remotes/origin/<base_branch>`
  when the worktree has a `base_branch`.
- If that ref no longer exists (for example, the parent was merged and its branch deleted), fall
  back to the default branch. Return a flag so the footer can show "Base branch `<x>` no longer
  exists; comparing with `<default>`".
- Fix the self-diff quirk: when only `upstreamBranch` is set, keep using the default branch as the
  base.

### Deleting a worktree

- **Children** keep `base_branch`. `parent_worktree_id` becomes null through the foreign key, and
  their pushed branches are untouched.
- **Confirmation dialog.** The delete dialog (`deleteWorktree`) warns: "N stacked workspaces are
  based on this branch. Deleting this workspace does not delete its branch."

### Spec and docs

- `.specs/cloud-agent-session.md`: add a "Stacked worktrees" section covering:
  - creating a stacked workspace;
  - the base-branch failure;
  - the diff base;
  - the owning-worktree rule;
  - the restack button rules;
  - what happens when a parent is deleted.
- `services/cloud-agent-next/docs/control-plane.md`: document route spec `baseBranch` and the
  checkout rules.

### Tests

- **Wrapper unit tests** (`prepare.test.ts`):
  - A new working branch is created at `baseSha` with `--no-track`.
  - A `baseSha` that is no longer on the base branch fails with `base_branch_changed`.
  - A missing base fails with `base_branch_missing`.
  - An existing local or remote working branch still restores, ignoring `baseSha`.
- **`getProviderBranchHead`**: GitHub, GitLab and Bitbucket mappings, a missing branch, and
  credential errors.
- **Worker**: schema validation, grouped metadata writes, and the sibling copy of `baseBranch`.
- **Web router**: authorization of `stackOnWorktreeId`, a repository mismatch, a `baseBranch`
  mismatch, and stacking on a worktree being deleted.
- **Session-ingest**: registration writes the parent and base on the first insert only, and
  rejects a parent from another owner.
- **Auto-commit**: the first push of a stacked branch is `push -u origin <branch>`.
- **Local end to end** (`cloud-agent-local-testing` skill, fake LLM):
  1. Create workspace A and let it auto-commit.
  2. Stack B on A.
  3. Confirm B's first commit has A's tip as its parent, and the Changes panel shows only B's
     changes.

## Phase 2: stack display in the sidebar and chat header

Lands before Phase 1, so stacks are visible as soon as they can be created.

1. **Data.**
   - `cliSessionsV2.worktreeDetails` (`cli-sessions-v2-router.ts:992-1131`) and the new
     worktree-level list (Phase 4) return `parentWorktreeId`, `baseBranch` and the worktree's
     branch.
   - After Phase 1 they also return `stackNumber` and `stackPosition` from the PR cache.
2. **Building the stack** on the client, in a pure function such as `buildWorkspaceStacks` with
   unit tests:
   - Edges come from `parent_worktree_id`.
   - After Phase 1, also add an edge when a worktree's PR `pr_base_ref` equals another open
     worktree's branch in the same repository, or when two worktrees share a GitHub
     `stack_number`.
   - Handle cycles and missing parents by treating the item as a root.
3. **Sidebar** (`ChatSidebar.tsx`):
   - A stack renders as one unit: the root row, then its layers indented in order.
   - Each layer has its own `PrBadge` and status indicator.
   - A collapsed stack shows "stack · N" and the most urgent status of its layers.
   - A stack is placed by its root; layers never appear on their own elsewhere.
4. **Chat header.** A breadcrumb like `main ← feat-a #12 (merged) ← feat-b #13 ← feat-c`. Each item
   opens that worktree. Layers outside Kilo show as plain text with a PR link.
5. **Behind parent.**
   - When the Changes panel's `comparison.mergeBase` differs from the parent's current head SHA,
     show a "Behind parent" badge on the worktree and in the header.
   - The parent's head SHA comes from the parent PR's `pr_head_sha`, or from the parent worktree's
     latest changes result.
6. **Design.** UI work in `apps/web` loads the `kilo-design-cloud` skill.

Tests: `buildWorkspaceStacks` unit tests, sidebar render tests for nesting and collapse, and the
breadcrumb.

## Phase 1: GitHub stacked pull requests

1. **PR base.** The Phase 0 instruction tells the agent to use `--base <base_branch>`. The agent
   needs nothing else, because the platform does the linking.
2. **Preinstall `gh-stack`** so an agent can use `gh stack link`/`view` when it wants to. It must be
   baked in at build time, because a runtime install fails under containment (see "Current
   state").
   - **Release to pin** (checked 2026-11-01): `gh-stack` **v0.3.0**, the latest release.
     - Assets are bare binaries named `<os>-<arch>`, with no archive and no checksums file. The
       linux-amd64 URL is
       `https://github.com/github/gh-stack/releases/download/v0.3.0/linux-amd64`.
     - SHA-256: `957e822cfa7e435cd84a297cd96c419b58e51e3ac58be249762c24bd9e45099b`. This matches
       the digest GitHub shows on the release page and a local download.
     - It is a statically linked x86-64 ELF of about 26.9 MB, so it also runs on the musl
       `Dockerfile.dind` image.
     - Requirements: `gh` ≥ 2.0 (the images ship 2.102.0 and 2.103.3) and git ≥ 2.36. The Ubuntu
       images install git from the git-core PPA and the trixie images ship git 2.47, so both
       qualify.
   - **Build.** Every sandbox image (`Dockerfile`, `Dockerfile.containers`,
     `Dockerfile.containers.runtime-free`, `Dockerfile.dind`, `Dockerfile.dev`) and the Vercel
     snapshot builder (`scripts/vercel-snapshot.ts`) install it the same way:
     ```
     ARG GH_STACK_VERSION="0.3.0"
     ARG GH_STACK_SHA256="957e822cfa7e435cd84a297cd96c419b58e51e3ac58be249762c24bd9e45099b"
     RUN wget -nv -O /tmp/gh-stack "https://github.com/github/gh-stack/releases/download/v${GH_STACK_VERSION}/linux-amd64" \
       && echo "${GH_STACK_SHA256}  /tmp/gh-stack" | sha256sum -c - \
       && install -D -m 0755 /tmp/gh-stack /usr/local/lib/gh-extensions/gh-stack/gh-stack \
       && rm /tmp/gh-stack
     ```
     Add the version and digest to `RUNTIME_DISTRIBUTION` (`src/shared/runtime-distribution.ts`),
     and make `sandbox-image-versions.test.ts` assert that all images match. The directory must be
     named `gh-stack` and the executable inside it `gh-stack`, which is how `gh` finds a local
     extension.
   - **Runtime.** In `prepareKiloFilesystem` (`wrapper/src/control-plane/kilo-runtime.ts:525-550`),
     which already writes into the runtime HOME before Kilo starts, create the symlink
     `$XDG_DATA_HOME/gh/extensions/gh-stack -> /usr/local/lib/gh-extensions/gh-stack`. If it already
     exists, leave it.
   - **Verified: a symlinked extension never updates itself** (2026-11-01). Tested with `gh` 2.102.0
     and 2.103.3 and `gh-stack` v0.3.0, using an isolated HOME and `XDG_*` laid out like the
     runtime HOME:
     - `gh extension list` shows `gh stack` with an empty repository and version, which is how
       `gh` lists a local extension.
     - `gh extension upgrade stack` refuses: "local extensions can not be upgraded".
     - `gh stack --version` and `gh stack view` run under a real TTY, with `GH_DEBUG=api`, make
       **zero** HTTP requests and write no update state.
     - Control: a normally installed copy (a directory with `manifest.yml`) runs `gh`'s extension
       update check, `GET /repos/github/gh-stack/releases/latest`, four requests per run. It caches
       the result for 24 hours in `$XDG_STATE_HOME/gh/extensions/gh-stack/state.yml`. The check
       only runs when stdout and stderr are terminals.
     - `GH_NO_EXTENSION_UPDATE_NOTIFIER=1` stops that check. `GH_STACK_NO_UPDATE_NOTIFIER=1` alone
       does not.
     - `gh-stack`'s own notifier reads the manifest (in debug output: "extension manifest tag ...
       does not match running version") and does nothing for a symlinked copy.
   - **Env.** As a backstop in case the layout changes, still set
     `GH_NO_EXTENSION_UPDATE_NOTIFIER=1` and `GH_STACK_NO_UPDATE_NOTIFIER=1` in
     `buildWorktreeKiloEnvironment` (`worktree-runtime.ts`, where `KILO_DISABLE_AUTOUPDATE` is set).
     The agent's terminals are real TTYs, so a non-local install would otherwise call the GitHub
     API with the session token on every run.
   - **Not under `/opt/kilo-cloud`.** That path is reserved for the runtime bootstrap
     (`RUNTIME_RESERVED_ROOT`).
   - **Optional skill.** The upstream `gh-stack` agent skill can be added as a runtime skill
     through the existing skills.sh materializer (`wrapper/src/runtime-skills.ts`).
   - **Test.** Add a wrapper test that the symlink is created under the runtime HOME.
3. **The platform links the stack.**
   - When a layer's PR becomes verified and the parent worktree's PR is open with
     `child.pr_base_ref == parent head ref`:
     - If the parent PR has a `stack_number`, call `POST /repos/{o}/{r}/stacks/{n}/add` with
       `[childPr]`.
     - Otherwise call `POST /repos/{o}/{r}/stacks` with `[parentPr, childPr]`.
   - Treat `422` (already linked or invalid) and `409` (another change in progress) as soft
     failures and retry `409` with backoff.
   - Make it idempotent with the stored `stack_number`.
   - Run it in `after()` from the webhook handler, using the installation token, in the same way
     the PR cache upsert runs.
   - Permissions: this needs Pull requests: write, which the standard app already has. For
     KiloConnect-Lite installations, skip linking and log at debug level. Kilo still groups the
     stack from `parent_worktree_id`.
4. **Webhook ingestion** (`upsert-cli-session-pull-requests.ts`, `webhook-schemas.ts`):
   - Add `stacked` to the tracked actions.
   - Parse `pull_request.stack` and `base.ref`, and store `pr_base_ref` and the stack columns.
   - On `edited` events with `changes.base`, update `pr_base_ref`. A retarget is then visible.
5. **Refresh.** `refreshAssociatedPullRequest` (`cli-sessions-v2-router.ts:1910`) also stores
   `pr_base_ref` and the stack data from the REST pull request resource.
6. **Stacks made outside Kilo.** Two worktrees that share a `stack_number` are grouped even without
   `parent_worktree_id`. Layers without a Kilo worktree appear only in the breadcrumb.
7. **Ship together with Phase 3's "remote branch changed" handling.** Once PRs are linked, GitHub
   itself force-pushes layer branches after partial merges and on "Rebase stack". Without that
   handling, the next auto-commit push in an affected worktree fails as non-fast-forward.

Tests:
- Webhook fixtures for `stacked`, for `edited` with `changes.base`, and for a payload carrying
  `stack`.
- Linking logic with mocked REST: create, add, `409` retry, `422` no-op, Lite installation
  skipped.
- Refresh mapping.
- Wrapper: the `gh-stack` symlink is created in the runtime HOME. Image versions match across
  Dockerfiles and the Vercel snapshot.

## Phase 3: keeping branches up to date

Nothing runs on its own. Every rewrite starts from a user action.

### 3a. Remote branch changed (GitHub rewrote it, or someone pushed)

**Detection:**
- When auto-commit's push fails as non-fast-forward, report a specific reason,
  `remote_branch_changed`, instead of a generic "push failed".
- The Changes panel refresh also compares `HEAD` with `origin/<branch>` after a fetch.

**User experience:**
- The worktree shows "Remote branch changed" with a **Sync** button.
- Local commits stay local and are never force-pushed over the remote.

**Sync**, a new wrapper control operation in `wrapper/src/control/` next to worktree changes:
1. Refuse while a turn is running or the working tree is dirty. Say why.
2. `git fetch origin <branch>`.
3. No unpushed local commits: `git reset --hard origin/<branch>`.
4. Unpushed local commits: `git rebase --onto origin/<branch> <old-remote-sha>`, where the old SHA
   is the last remote SHA this worktree pushed or fetched.
5. On conflict: `git rebase --abort`, then hand off to the agent (see 3c).

### 3b. Restack onto the parent

**Triggers:**
- "Behind parent" is shown.
- The parent PR was merged or closed.
- The parent's base changed.

**Buttons:**
- **Restack** on a layer restacks that layer.
- **Restack stack** on the root runs the layers in order, bottom up, each in its own worktree's
  sandbox. It stops at the first conflict.

**Restack operation**, a wrapper control operation run in the layer's own sandbox:

```
git fetch origin
newBase = parent merged/closed ? <parent's base, e.g. main> : <parent branch>
git rebase --onto origin/<newBase> <upstreamSha>
git push --force-with-lease=<branch>:<expected-remote-sha> origin <branch>
```

**`upstreamSha`**, in order of preference:
1. `cloud_agent_worktrees.base_sha`;
2. the parent PR's last `pr_head_sha` from the cache;
3. `git merge-base HEAD origin/<old base>`, if that branch still exists.

Using the parent's last head SHA is correct even if the layer was created from an older parent
commit. `rebase --onto X Y` replays `Y..HEAD`, which leaves out everything reachable from Y. That
includes the original fork point, as long as the parent was not rewritten after the layer was
created.

**After success:**
- Update `base_branch` (when it changed) and `base_sha`.
- For GitHub, retarget the PR with `PATCH /pulls/{n}` `{ base }` if GitHub has not already done it.

**Constraints:**
- **Owning worktree only.** A layer's sandbox never rewrites another layer's branch. This is why
  `gh stack rebase` is not used across the stack.
- **Prefer GitHub when it has already rebased.** If GitHub has already rebased a linked stack,
  Restack becomes Sync (3a).
- **No GitHub rebase API.** There is no REST or GraphQL endpoint for "Rebase stack" (checked
  2026-11-01), so Kilo cannot trigger GitHub's server-side rebase. For a linked GitHub stack, the
  Restack menu offers two choices:
  - **Restack in Kilo**: the operation above.
  - **Rebase on GitHub**: a link to the top layer's PR, where the merge box shows "Rebase stack".
    It needs no sandbox and keeps approvals. Afterwards each worktree shows "Remote branch
    changed", and Sync (3a) brings it up to date.
- **Waking sandboxes.** Restacking an idle worktree prepares its sandbox the same way a message
  does. The button says so, and progress uses the existing preparation steps.

### 3c. Conflicts go to the agent

On any conflict in Sync or Restack:
1. Abort, leaving the branch as it was.
2. Start a turn in that worktree with a generated, precise message: the operation, the exact
   command, the conflicted files and the expected result. For example: "Rebase `feat-b` onto
   `origin/main` with `git rebase --onto origin/main <sha>`, resolve conflicts in X and Y, run the
   tests, then push with `--force-with-lease`."
3. Show "Agent resolving conflicts" in the sidebar.

`auto-commit` keeps its plain push. Only the Sync and Restack operations, and the agent following
the generated message, may force-push, and only with a lease.

### Base SHA

`cloud_agent_worktrees.base_sha` has one writer, the web router. It is set at creation and only
moves forward after that.

| When | Value | How it gets there |
|---|---|---|
| Creation | The base branch head resolved by `getProviderBranchHead` | Passed as `baseSha` through `prepareSession`, the Worker and registration. The wrapper checks out exactly that commit (Phase 0), so the value is true by construction. |
| After Restack | The new parent tip the layer was rebased onto | Returned in the Restack operation result (request and response through Worker, Session DO and Sandbox DO), then written by the web router. |
| After Sync | `git merge-base HEAD origin/<base_branch>` after the sync | Returned in the Sync result. This covers GitHub's own rebases, after which the base is usually the trunk, which is never rewritten. |

- **Restack and Sync are request and response.** They follow the worktree-changes pattern
  (`worktree.summary` and `worktree.result`, `src/shared/worktree-changes-wire.ts`). The result
  schema is validated, so no new frame type is added to the wrapper's protocol with the DO.
- **Sibling chats** don't check out a new branch, so they never change `base_sha`.
- **Rebuilt worktrees** restore their own pushed branch, which keeps its history, so `base_sha`
  stays valid.
- **Missing `base_sha`** (worktrees created before this change, or a failed write): Restack uses the
  fallback chain in 3b. This only gives a wrong result if the parent was force-pushed after the
  layer was created. In that case the rebase hits a conflict and goes to the agent; it cannot lose
  commits.
- **Optional refinement.** When a Changes panel result has
  `comparison.baseRef == origin/<base_branch>` and its `mergeBase` is a descendant of the stored
  `base_sha`, the router may move `base_sha` forward to it. This covers parent updates the agent
  merged by hand.

### Tests

- **Wrapper operation tests**: Sync (reset path, rebase path, dirty tree refused, conflict
  aborts), and Restack (merged-parent squash case, open-parent case, lease rejection, conflict
  aborts).
- **Auto-commit**: classifies a non-fast-forward push as `remote_branch_changed`.
- **End to end** with a local git remote:
  1. Create stack A ← B.
  2. Squash-merge A into main.
  3. Restack B.
  4. Confirm B contains only its own commits on top of main.

## Phase 4: sidebar ordering, smart folders and the Sidebar settings tab

### Rows and default ordering

| Row kind | Contents | Order |
|---|---|---|
| Workspace | Worktree rows (browser `cloud-agent-web` with a registered worktree) and their stacks | User setting: **Manual** (default for new users), Created, or Last activity |
| Session | Single-session rows: bots (`slack`, `discord`, `linear`, `github`), triggers (`webhook`, `scheduled`), reviews (`code-review`, `security-*`), mobile or API sessions without a worktree | Always by last activity, aged out after 5 days, as today |

**Manual order:**
- Rows without a position sort first by `created_at` descending, so new workspaces appear on top.
  Positioned rows follow in `sidebar_position` order.
- Dragging a row sets its fractional `sidebar_position`, so only that row is written.
- A stack is dragged as one unit; only the root has a position.
- Rows within a folder are ordered by that folder's `sort_mode`.

**Existing users** keep Last activity until they change the setting. New users get Manual.

### Loading workspaces independently of the 5-day window

Add `cliSessionsV2.listWorkspaces`, one row per worktree. It returns:
- id, name, the label fallback, `created_at`, last activity (`max(coalesce(last_activity_at, created_at))`
  over its chats), `folder_id`, `sidebar_position`, `parent_worktree_id`, `base_branch`, branch;
- PR state, review decision and stack data from the PR cache;
- aggregated live status.

**Rows included:**
- Every worktree that isn't deleted and has no PR, or an open or draft PR, whatever its age.
- Worktrees with a merged or closed PR, only when their last activity is within 5 days. Older ones
  are still found by search.

**Limits.** Cap at 200 open workspaces. If the cap is hit, page and show a notice.

**Relation to the existing list.** The per-chat `cliSessionsV2.list` stays for single sessions and
for the chats inside a worktree. The server prefetch in `PrefetchedCloudSidebar.tsx` adds
`listWorkspaces`. The per-folder latest-session queries in `sidebar-queries.ts` can be removed
afterwards.

### Smart folders

Presets are stored as folder rows with `kind: 'smart'`. Each preset has a membership rule:

| Preset | Contains |
|---|---|
| Needs you | Any layer has status `attention`, a pending question, or a failed last turn |
| In review | At least one open or draft PR, and no layer needs you |
| Done | Every layer's PR is merged or closed (collapsed by default, aged out after 5 days) |

**Precedence, so each workspace or stack appears exactly once:**
1. Needs you
2. Manual folder
3. In review / Done
4. Unfiled

A manual folder wins over automatic classification. Only the urgent "Needs you" overrides it.

**Order inside a smart folder:**
- Needs you: oldest waiting first, by `status_updated_at`.
- In review and Done: by the folder's `sort_mode`.

Smart folders take part in folder `position` ordering, collapse and rename like manual folders.

### Sidebar settings tab

Add a **Sidebar** tab to `CloudAgentSettingsDialog.tsx`, and add `'sidebar'` to `initialSection`:

- **Smart folders:** a toggle each for Needs you, In review and Done.
  - Turning one on creates the folder row; turning it off deletes it.
  - Removing the folder from the sidebar folder menu turns the same toggle off. The folder row is
    the only place this is stored.
- **Workspace order:** Manual, Created, or Last activity, stored in
  `cloud_agent_sidebar_preferences`.
- **Sessions:** a note that single sessions are always sorted by date.

**Scope.** This tab is personal:
- Every member can edit it, including inside an organization.
- It does not use the admin-only `cloudAgentSettings` mutations.
- It shows "Only you" in place of the organization view-only notice.

**Routers:**
- Extend `workspaceFolders` (`apps/web/src/routers/workspace-folders-router.ts`) with smart-folder
  create and delete, `sort_mode` updates, and `moveWorktree` with a position.
- Add a small `cloudAgentSidebarPreferences` router with `get` and `set`.
- Scope everything to the caller's user and organization.

**Sidebar folder menu.** Keep "New folder" in the "+" menu. Each folder's own menu gets a sort mode
choice and Remove. Smart folders are added from Settings only.

### Tests

- Pure functions for row classification, precedence, manual ordering with null and fractional
  positions, and stack placement.
- Router tests for `listWorkspaces` inclusion rules, preferences, smart-folder uniqueness and
  scoping, and member-editable access in organizations.
- Settings tab render tests.
- Browser check of drag-reorder and toggling smart folders (`local-development` or
  `agent-browser` skill).

## Delivery order

1. **S0**: sorting fix.
2. **Phase 0**: `baseBranch`, `stackOnWorktreeId`, the sidebar action, worktree columns and the diff
   base.
3. **Phase 2**: stack display.
4. **Phase 1 + Phase 3a**: GitHub stack linking with "Remote branch changed" and Sync. These must
   ship together.
5. **Phase 3b/3c**: Restack and agent conflict handoff.
6. **Phase 4**: `listWorkspaces`, manual order, smart folders and the Sidebar settings tab. This is
   independent of stacking and can run in parallel with steps 3-5. Manual order is needed before
   stacks get large.

Gate each user-visible phase behind the web app's existing feature-flag mechanism until the end to
end checks pass.

## Edge cases

- **Parent never pushed.** The menu item is disabled with a reason. The server preflight and the
  wrapper `base_branch_missing` error are backstops.
- **The agent switches branch in a layer.** Auto-commit pushes whatever branch is checked out, and
  the instruction tells the agent not to. The stack link stays on the worktree. The UI follows the
  worktree's metadata branch, and a PR whose head ref doesn't match is not verified, as today.
- **The parent is deleted.** The child keeps `base_branch`. "Behind parent" is unavailable, and
  Restack offers the parent's base, or the default branch if the parent branch is gone.
- **The parent is merged and its branch deleted.** The Changes panel falls back to the default
  branch with a notice. Restack targets the parent's base. A GitHub-linked stack is retargeted by
  GitHub.
- **A layer in the middle is merged.** GitHub merges the layers below it and retargets the ones
  above. Kilo worktrees for the merged layers move to Done, and the rest show "Remote branch
  changed" or "Behind parent".
- **Two worktrees end up on the same branch** (an explicit `upstreamBranch` on a stacked branch).
  Stack building keys on `parent_worktree_id` first, so this doesn't break grouping. The
  owning-worktree rule still applies, and Sync and Restack refuse when a sibling worktree claims
  the same branch.
- **Forks across repositories.** GitHub stacks need a single repository. Stacking requires the
  parent's `git_url`, and the PR cache already ignores PRs from other repositories.
- **GitLab and Bitbucket.**
  - Available: Phase 0, Phase 2 grouping by `parent_worktree_id`, Restack without automatic
    retargeting, and Sync.
  - Not available: linking or retargeting through the provider API.

## Risks

- **Force-push safety.** Only the Sync and Restack operations force-push, always with a lease
  pinned to the expected remote SHA, and only on the worktree's own branch.
- **Auto-commit after a GitHub rewrite.** This is handled by `remote_branch_changed` and Sync
  (Phase 3a). Do not ship Phase 1 without it.
- **Cost of waking sandboxes.** Restack stack wakes one sandbox per layer, one after another. Show
  this before starting.
- **GitHub Stacks API limits.** Linking is best effort. The UI still groups stacks by
  `parent_worktree_id` when linking fails.
- **Index build on `cli_sessions_v2`.** Use the concurrent build and long-build procedure from
  `packages/db/AGENTS.md`.

## Resolved questions (2026-11-01)

| Question | Answer |
|---|---|
| Does the Stacks API have a server-side rebase endpoint? | No. The REST API only has list, get, create, add and unstack; GraphQL is read-only. "Rebase stack" is only a button in the PR merge box. Restack stays a Kilo git operation, with a "Rebase on GitHub" link as an alternative (3b). |
| Does the GitHub App's permission cover the Stacks endpoints? | Yes. They need repository permission "Pull requests" (write to create or change, read to read) and accept installation tokens. The standard KiloConnect app already has Pull requests: write. KiloConnect-Lite is read-only, so linking is skipped for it. |
| Where do `gh` extensions live in the sandbox? | `$XDG_DATA_HOME/gh/extensions` = `/home/<sha256(worktree directory)>/.local/share/gh/extensions`. It starts empty in each new sandbox, and an extension installed into `/root` is invisible. Bake the binary into `/usr/local/lib/gh-extensions/gh-stack` and symlink it in `prepareKiloFilesystem` (Phase 1). |
| How is `base_sha` recorded at creation? | The web router resolves the base branch head with one provider call, which is also the preflight. It passes the SHA down, and the wrapper checks out exactly that commit. No new wrapper-to-platform channel is needed (Phase 0, "Base SHA"). |
| Does `gh` treat a symlinked extension directory as local? | Yes, tested with `gh` 2.102.0 and 2.103.3. It is listed without a repository or version, refuses to upgrade, and makes no update-check requests even under a TTY. A normal install makes four requests per run and is only stopped by `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`. |
| Which `gh-stack` asset and checksum? | v0.3.0 (latest). The asset is the bare binary `.../releases/download/v0.3.0/linux-amd64`, SHA-256 `957e822cfa7e435cd84a297cd96c419b58e51e3ac58be249762c24bd9e45099b`, statically linked. There is no checksums file; the digest matches the one GitHub shows on the release page. |

## Open items to settle during implementation

- Whether new users get any smart folders on by default. The current proposal is none.
