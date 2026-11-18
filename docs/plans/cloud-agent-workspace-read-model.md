# Plan: Simplify Cloud Agent workspace and session reads

Status: Implemented. Local verification results appear in section 9.

## 1. Keep clear storage ownership

Keep PostgreSQL as the directory for workspaces, session membership, and historical discovery.

Keep existing storage for other responsibilities:

- **Session Ingest DO/R2:** transcripts and messages.
- **Cloud Agent DOs:** runtime coordination and execution state.
- **PostgreSQL:** searchable metadata, PR information, workspace summaries, session summaries, and workspace tab state.

Do not introduce a workspace directory in a DO.

Chat membership stays on the chat: `cli_sessions_v2.cloud_agent_worktree_id`. Session Ingest writes it in the same transaction that creates the chat (`registerCloudAgentWorktree`). Do not add a second membership list on the workspace.

### Migration

One migration adds these columns to `cloud_agent_worktrees`:

| Column | Type | Purpose |
|---|---|---|
| `closed_session_ids` | `text[]`, default `'{}'` | Closed chat tabs, most recently closed first. |
| `tab_order` | `text[]`, default `'{}'` | Order of open chat tabs. |
| `last_activity_at` | `timestamptz`, nullable | Newest chat activity in the workspace. Selects the last 50 ungrouped workspaces. |

- Store closed chats, not open chats. A new chat is then open with no extra write.
- A chat that is not in `tab_order` goes after the ordered tabs, by creation time.
- Session Ingest writes `last_activity_at` with the same monotonic guard as `cli_sessions_v2.last_activity_at` (`persistLiveSessionColumns`).
- Read the newest root chat when `last_activity_at` is null or stale. Do not backfill all workspaces during deployment.
- Add an index on `(kilo_user_id, organization_id, last_activity_at DESC)` for rows that are not deleted.

Follow `packages/db/AGENTS.md` and the `database-migrations` skill.

## 2. Define distinct read models

| Read model | Contents | Load trigger |
|---|---|---|
| **Workspace summary** | Name, repository, branch, folder, sidebar destination, ordering, PR, activity, status source chat, open chats in tab order, closed chats, `hasOpenRun`, navigation IDs | Sidebar load |
| **Workspace chats** | Paginated chat summaries for one workspace | Open workspace |
| **Standalone sessions** | Session summaries without workspace membership | Sidebar load |
| **Chat content** | Messages and runtime details | Open chat |

Folders and preferences remain separately cached because they change infrequently.

Workspace summaries must contain everything needed to render sidebar rows and to open a workspace on its latest open chat. They must not require individual chat metadata or transcripts.

The summary names the chat that supplies its status. The open chat's live status can then replace the summary status immediately.

## 3. Give workspace activity one owner

Extract the activity rules into a framework-independent module. The server uses it to calculate the workspace summary. The client does not calculate workspace activity from a chat list.

### Activity rules

1. Rank: question or permission, then running or retry, then failure or unexpected interruption, then idle. A failure never ranks above running work.
2. Failure: only a failure on the most recently active chat counts.
3. Newer status: a status newer than a failure hides that failure, including idle. This intentionally replaces the former client's idle-status fallback to an older failure.
4. Stale status: busy or retry that is 3 hours old or more counts as stale. This replaces the current 20-minute client rule.

### Remove queued runs from activity

Today the server counts `queued` and `accepted` runs as running in `aggregateWorkspaceStatus`. No web code reads that result. Remove this rule.

The client reads `latest_run_status` only to keep the 30-second poll on. Run failures arrive only through `cloud_agent_session_runs`, and no event reports them. Replace this use with one summary flag, `hasOpenRun`, used only for polling. A later change can let cloud-agent-next send a run-failure event, and then remove the flag.

These rule changes alter the server result. Record each change in the tests and in the spec.

## 4. Define sidebar visibility on the server

The server decides the destination of each workspace and returns it in the summary. Move the destination rule from `groupWorkspaceGroupsByDestination` (`sidebar-ordering.ts`) to the shared module.

A stack counts as one item. Its manual folder comes from its root. Smart-folder rules inspect every layer, as before.

| Destination | Rows shown |
|---|---|
| "Needs you" smart folder | All |
| Manual folder | All, to a maximum of 500 per folder |
| "In review" smart folder | All, to a maximum of 500 |
| "Done" smart folder | All, to a maximum of 500 |
| Ungrouped | The last 50 stacks, by the newest activity of any layer |

- The server selects rows by activity, then the client shows them in the user's chosen order.
- When a folder has more than 500 rows, the response includes the total. The sidebar shows a notice with that total.
- Search finds workspaces that the sidebar does not show.
- These rules replace the 5-day rule for merged or closed PRs in `listWorkspaces` and the 5-day rule for ungrouped rows in `ChatSidebar.tsx`.
- Increase `SMART_FOLDER_WORKTREE_ORDER_LIMIT` (`apps/web/src/lib/cloud-agent/workspace-folders.ts`) from 200 to 500, so that a manual order can include every row that a smart folder shows.

## 5. Simplify the backend queries

Reuse existing routers where practical. Keep shared query logic outside the large router file.

### Workspace list

Start the list from `cloud_agent_worktrees`, not from all root chats.

1. Select the rows to show (section 4). Use `last_activity_at` and `folder_id` on the workspace row.
2. Read chats, latest runs, and the workspace PR only for those rows.
3. Calculate status with the shared activity module.

Today `listWorkspaces` reads every root chat, with no time limit, and then groups them. For each chat it does one PR lookup and three subqueries on the runs table (`latestRunField`). The work grows with the user's total chats. Each workspace has its own row since migration `0234`, and the workspace PR already matches on `cloud_agent_worktrees.git_url` and `git_branch`.

Also:

- Preserve account, platform, repository, folder, and ordering behavior.
- Return the effective workspace ordering, so the client does not read sidebar settings in a separate request.

### Workspace summary refresh

Provide a bounded, batched read for summaries by workspace ID.

Use the same query and activity rules as the workspace list. This supports live refreshes, direct links, and stack ancestors that the list does not include.

### Workspace chats

Keep the PostgreSQL query filtered by workspace membership.

- Return summaries, not transcripts.
- Exclude agent-created child sessions from the normal chat list.
- Apply no five-day cutoff.
- Use stable pagination with a timestamp and session-ID tie-breaker.
- Preserve ownership and organization access checks.

### Standalone sessions

Add an explicit standalone-session filter.

The sidebar's general session query must no longer return chats that workspace summaries already show.

Preserve public API compatibility for other clients.

## 6. Store tab state on the workspace

Move closed tabs and tab order from `localStorage` (`useClosedWorktreeChatTabs.ts`, `worktree-chat-tabs.ts`) to the columns in section 1.

- Add mutations to close, reopen, and reorder tabs. Each mutation changes the arrays in one SQL statement, so concurrent windows do not lose writes.
- Reopening a chat removes it from `closed_session_ids`. Deleting a chat removes it from both arrays.
- The workspace summary returns open chats in tab order and closed chats, most recently closed first.
- Server prefetch includes this state, so closed tabs do not show before the first paint.
- On first load, import the closed tabs and order from this browser's `localStorage` once, then delete the key.
- Keep the navigation fixes from `4ef5578a75` and `4713a9c6f6`. Server storage does not replace them.

Update `.specs/cloud-agent-session.md` Shared Worktrees rules 10 and 11: closed tabs and tab order sync across devices.

## 7. Simplify frontend loading and state

Replace the combined responsibilities in `useSidebarSessions` with focused hooks:

- Workspace summaries.
- Standalone sessions.
- Selected workspace chats.
- Live updates and refresh coordination.

Then:

- Remove sidebar-wide `worktreeDetails` loading and server prefetch.
- Stop using recent workspace chats to construct workspace rows.
- Open a workspace on its latest open chat from the summary, without a chat-list request.
- Reuse cached summaries for stack navigation.
- Fetch missing stack summaries in one batched request instead of one `worktreeDetails` request for each ancestor.
- Keep server results in React Query.
- Keep pending local chats and foreground interaction state separate.

Show workspaces and sessions in separate sections in all sort modes. This removes the mixed date groups in activity order (`ChatSidebar.tsx`). Keep the 60-second step for running rows (`SIDEBAR_RUNNING_BUMP_INTERVAL_MS`), so that rows do not jump during a run.

Retain server prefetch and hydration. Preserve search across older chats and workspaces without preloading them.

## 8. Narrow live updates and polling

Keep the existing WebSocket connection.

Add a `workspace.updated { worktreeId }` event. Session events do not always carry `worktreeId`, and sessions and workspaces stay distinct. Session Ingest already reads `cloud_agent_worktree_id` where it sends session events (`metadata.ts`).

| Source | Event | Client refresh |
|---|---|---|
| Chat created, deleted, renamed, or status change | Session event and `workspace.updated` | Affected workspace summary and any loaded chat row |
| Workspace rename, folder move, tab change | `workspace.updated` | Affected summary and list membership |
| Repository changes | Existing event | Relevant project-filter data |
| Reconnect | None | Active sidebar scope |

Group affected workspace IDs and refresh them after about 300 ms. The server stays the only owner of workspace status.

Keep foreground chat feedback immediate.

Polling:

- Poll a workspace row only while it has running work or `hasOpenRun`, or while PR information is pending.
- Stop polling a row when its busy or retry status is 3 hours old or more.
- Completed sessions must not keep frequent polling active because they have cloud-agent IDs. Today `useActiveSessions` polls every 10 seconds in all states.

## 9. Verify behavior and reduced work

Record a baseline, then compare the same scenarios after implementation:

- Initial sidebar load.
- Opening a workspace.
- Idle sidebar.
- Active chat and status transitions.
- Search, filters, folders, smart folders, and stack navigation.
- Tab close, reopen, and reorder in two windows and two browsers.
- Reconnect and deletion.

Add focused tests for activity rules, destination and visibility rules, PostgreSQL queries, pagination, tab-state mutations, access boundaries, and refresh coordination.

Verify the running local app and capture request counts.

### Implementation and local evidence

- Migration `0363_workspace_read_model` adds tab state and activity. Its five concurrent indexes support workspace activity, active chats, and latest/open runs. Existing rows need no backfill because reads also use the newest root chat.
- Workspace reads classify compact directory signals before loading selected tab summaries. PR reads run per workspace, not per chat.
- Summary refresh reads status and run signals only for the requested connected stacks. Chat pagination uses creation time and the session ID, including PostgreSQL microseconds.
- Summaries retain all open and closed tab summaries, as required. Payload size therefore depends on chats in selected workspaces, not hidden chat history.
- The workspace checkout owns its PR. The read model does not restore the former chat-link fallback or orphan chats without workspace rows.
- The local heavy fixture has 2,000 workspaces, 10,000 root chats, a 600-row folder, and a 20-layer stack.
- The first baseline HTTP workspace read took 341 ms and returned 200 rows. The final comparison below calls both implementations directly against the same local database. It excludes the first iteration.
- Local sidebar rows rendered from server hydration without `worktreeDetails` requests. Opening a workspace selected its latest open tab before any chat-list read.
- Two independent browsers synchronized tab close, reopen, and relative reorder. A real Worker WebSocket check covered 200-ID batches, access refusal, rename/delete events, array cleanup, and final-root rollback.
- A fresh document imported legacy closed tabs for an untouched workspace and removed the browser key. An idle workspace issued no sidebar or active-session queries during a 73-second observation.
- Browser testing found a StrictMode cleanup defect in refresh coordination. The fix has a regression test that fails against the previous lifecycle.
- Focused tests cover SQL access and concurrency, activity and visibility, pagination, legacy import, optimistic changes, reconnects, and background polling.
- Final checks passed: web, database, SDK, and Session Ingest typechecks; changed-file type-aware lint; schema/migration consistency; and 2,091 focused tests. Two existing Worker tests remain skipped.

The synthetic sidebar checks do not exercise a full agent run. Those fixtures contain metadata only.

| Read, 10,000 root chats | Previous server / query time | New server / query time | Previous / new rows |
|---|---|---|---|
| Workspace list | 214–217 / 192–198 ms | 240–281 / 167–191 ms | 200 / 569 |
| One workspace summary | 6 / 8–9 ms | 16–18 / 14–16 ms | 1 / 1 |
| Workspace chats | 4 / 2 ms | 1–2 / 1 ms | 5 / 5 |

Query time sums the client-observed duration of database queries. Parallel queries can exceed server time. The new summary also calculates stack destination and returns tab state; the previous details read did not.

Adding 10,000 older root chats only to hidden workspaces increased the previous list read to 577–1,034 ms. The new list remained at 251–259 ms and returned the same 569 rows. The added fixtures were then removed. The new initial list returns more rows, so it does not always beat the old 200-row page in server time. These development measurements are not production latency guarantees.

Measure latency for a heavy user. Seed a local user with about 2,000 workspaces, 10,000 root chats, a folder over 500 rows, and deep stacks. Record server time and database time for the workspace list, the summary refresh, and the workspace chat list, before and after.

### Acceptance criteria

- Sidebar rows render without `worktreeDetails` requests.
- The general sidebar session query excludes workspace chats.
- Opening a workspace needs no chat-list request to select its tab.
- Workspace activity and destination have one implementation, on the server.
- A failure never ranks above running work.
- Workspace list time does not grow with the user's total chats.
- Closed tabs and tab order sync across browsers.
- Status events do not refresh unrelated repositories or full session lists.
- Idle work does not cause frequent polling.
- Existing search, navigation, access checks, and recoverability remain intact.

Implement this in stages:

1. Migration and shared activity and destination rules.
2. Backend reads.
3. Tab-state mutations and spec update.
4. Frontend loading.
5. Live refreshes and polling.
6. Local verification.

## Current implementation references

- Sidebar query inputs: `apps/web/src/components/cloud-agent-next/hooks/sidebar-queries.ts`.
- Sidebar loading and client activity rules: `apps/web/src/components/cloud-agent-next/hooks/useSidebarSessions.ts`.
- Server activity rules and queries: `aggregateWorkspaceStatus`, `listWorkspaces`, `worktreeDetails` in `apps/web/src/routers/cli-sessions-v2-router.ts`.
- Sidebar destination rules: `apps/web/src/components/cloud-agent-next/sidebar-ordering.ts`.
- Smart folder definitions: `apps/web/src/components/cloud-agent-next/settings/sidebar-settings.ts`.
- Server prefetch: `apps/web/src/components/cloud-agent-next/server/PrefetchedCloudSidebar.tsx`.
- Selected workspace chat loading: `apps/web/src/components/cloud-agent-next/CloudSidebarLayout.tsx`.
- Workspace indicator rendering and sections: `apps/web/src/components/cloud-agent-next/ChatSidebar.tsx`.
- Stack navigation reads: `apps/web/src/components/cloud-agent-next/useChatStackInfo.ts`.
- Tab state: `apps/web/src/components/cloud-agent-next/hooks/useClosedWorktreeChatTabs.ts`, `apps/web/src/components/cloud-agent-next/worktree-chat-tabs.ts`.
- Workspace row creation: `registerCloudAgentWorktree` in `services/session-ingest/src/services/worktree-deletion.ts`.
- Session events and activity writes: `services/session-ingest/src/ingest/metadata.ts`, `services/session-ingest/src/dos/SessionIngestDO.ts`.
- Schema: `cloud_agent_worktrees` and `cli_sessions_v2` in `packages/db/src/schema.ts`.
- Spec: Shared Worktrees rules in `.specs/cloud-agent-session.md`.
