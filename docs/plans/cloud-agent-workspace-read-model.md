# Plan: Simplify Cloud Agent workspace and session reads

Status: Proposed. No implementation changes have been made.

## 1. Keep clear storage ownership

Keep PostgreSQL as the directory for workspaces, session membership, and historical discovery.

Keep existing storage for other responsibilities:

- **Session Ingest DO/R2:** transcripts and messages.
- **Cloud Agent DOs:** runtime coordination and execution state.
- **PostgreSQL:** searchable metadata, PR information, workspace summaries, and session summaries.

Do not introduce a workspace directory in a DO. No database migration is planned.

## 2. Define distinct read models

| Read model | Contents | Load trigger |
| --- | --- | --- |
| **Workspace summary** | Name, repository, branch, folder, ordering, PR, activity, chat count, navigation IDs | Sidebar load |
| **Workspace chats** | Paginated chat summaries for one workspace | Open workspace |
| **Standalone sessions** | Session summaries without workspace membership | Sidebar load |
| **Chat content** | Messages and runtime details | Open chat |

Folders and preferences remain separately cached because they change infrequently.

Workspace summaries must contain everything needed to render sidebar rows. They must not require individual chat metadata or transcripts.

## 3. Give workspace activity one owner

Extract the activity rules from UI code into a framework-independent module.

Use that module to calculate the authoritative workspace summary on the server.

Preserve the intended visible behavior:

1. Questions and permission requests.
2. Running or retrying work.
3. Relevant failures or unexpected interruptions.
4. Idle.

Also preserve stale-status handling and the rule that limits which historical failure appears.

Resolve the current backend/frontend differences explicitly. Do not silently change indicator behavior during the refactor.

**The client must not independently calculate authoritative workspace activity from an incomplete chat list.**

## 4. Simplify the backend queries

Reuse existing routers where practical. Keep shared query logic outside the large router file.

### Workspace list

Extend or adjust `cliSessionsV2.listWorkspaces` so it supplies the complete sidebar summary.

- Preserve account, platform, repository, folder, and ordering behavior.
- Preserve workspace visibility beyond the recent-session window.
- Read workspace PR information and latest-run information without unnecessary repeated lookups.
- Return the effective workspace ordering, avoiding a separate sidebar settings read.

### Workspace summary refresh

Provide a bounded, batched read for summaries by workspace ID.

Use the same query and activity rules as workspace listing. This supports live refreshes, direct links, and missing stack ancestors.

### Workspace chats

Keep the PostgreSQL query filtered by workspace membership.

- Return summaries, not transcripts.
- Exclude agent-created child sessions from the normal chat list.
- Apply no five-day cutoff.
- Use stable pagination with a timestamp and session-ID tie-breaker.
- Preserve ownership and organization access checks.

### Standalone sessions

Add an explicit standalone-session filter.

The sidebar's general session query must no longer return chats already represented by workspace summaries.

Preserve public API compatibility for other clients.

## 5. Simplify frontend loading and state

Replace the combined responsibilities in `useSidebarSessions` with focused hooks:

- Workspace summaries.
- Standalone sessions.
- Selected workspace chats.
- Live updates and refresh coordination.

Then:

- Remove sidebar-wide `worktreeDetails` loading and server prefetch.
- Stop using recent workspace chats to construct workspace rows.
- Reuse cached summaries for stack navigation.
- Fetch missing stack summaries directly instead of loading another unfiltered workspace list.
- Keep server results in React Query.
- Keep pending local chats, tab state, and foreground interaction state separate.

Retain server prefetch and hydration. Preserve search across older chats without preloading those chats.

## 6. Narrow live updates and polling

Keep the existing WebSocket connection.

Map events to the resources they affect:

| Event | Refresh |
| --- | --- |
| Chat status changes | Affected workspace summary and any loaded chat row |
| Chat created or deleted | Workspace summary and that workspace's loaded chat list |
| Workspace metadata changes | Affected summary and relevant list membership |
| Repository changes | Relevant project-filter data |
| Reconnect | Active sidebar scope |

Batch affected workspace IDs after a short, bounded delay.

Keep foreground chat feedback immediate. Refresh workspace aggregates from the server instead of recalculating them from partial caches.

Retain fallback polling for active work and pending PR information.
Completed sessions must not keep frequent polling active merely because they have cloud-agent IDs.

## 7. Verify behavior and reduced work

Record a baseline, then compare the same scenarios after implementation:

- Initial sidebar load.
- Opening a workspace.
- Idle sidebar.
- Active chat and status transitions.
- Search, filters, folders, and stack navigation.
- Reconnect and deletion.

Add focused tests for activity rules, PostgreSQL queries, pagination, access boundaries, and refresh coordination.

Verify the running local app and capture request counts.

### Acceptance criteria

- Sidebar rows render without `worktreeDetails` requests.
- The general sidebar session query excludes workspace chats.
- Opening a workspace loads its chats on demand.
- Workspace activity has one authoritative implementation.
- Status events do not refresh unrelated repositories or full session lists.
- Idle work does not cause frequent polling.
- Existing search, navigation, access checks, and recoverability remain intact.

Implement this in stages:

1. Shared activity rules.
2. Backend reads.
3. Frontend loading.
4. Live refreshes.
5. Local verification.

## Current implementation references

- Sidebar query inputs: `apps/web/src/components/cloud-agent-next/hooks/sidebar-queries.ts`.
- Sidebar loading and activity rules: `apps/web/src/components/cloud-agent-next/hooks/useSidebarSessions.ts`.
- Server prefetch: `apps/web/src/components/cloud-agent-next/server/PrefetchedCloudSidebar.tsx`.
- Selected workspace chat loading: `apps/web/src/components/cloud-agent-next/CloudSidebarLayout.tsx`.
- Workspace indicator rendering: `apps/web/src/components/cloud-agent-next/ChatSidebar.tsx`.
- Stack navigation reads: `apps/web/src/components/cloud-agent-next/useChatStackInfo.ts`.
- PostgreSQL session and workspace queries: `apps/web/src/routers/cli-sessions-v2-router.ts`.
